/**
 * Glacier Restore & DataSync - Web UI Application
 *
 * Single-page application with vanilla JS for submitting restore requests
 * and monitoring their status in real time.
 */

/* global window, document, fetch, setInterval, clearInterval */

(function () {
  'use strict';

  // --- Configuration ---
  const API_BASE_URL = (window.__CONFIG__ && window.__CONFIG__.apiUrl) || window.API_BASE_URL || '';
  const STATUS_POLL_INTERVAL_MS = 10000; // 10 seconds
  const ELAPSED_TIME_UPDATE_MS = 5000;   // 5 seconds
  const CONNECTIVITY_TIMEOUT_MS = 30000; // 30 seconds

  // --- State ---
  let requests = [];
  let statusPollTimer = null;
  let elapsedTimeTimer = null;
  let lastSuccessfulFetch = Date.now();
  let connectivityWarningVisible = false;

  // --- DOM References ---
  const form = document.getElementById('restore-form');
  const bucketInput = document.getElementById('bucket-input');
  const filePathsInput = document.getElementById('file-paths-input');
  const tierSelect = document.getElementById('tier-select');
  const submitBtn = document.getElementById('submit-btn');
  const formSuccess = document.getElementById('form-success');
  const formErrorGlobal = document.getElementById('form-error-global');
  const bucketError = document.getElementById('bucket-error');
  const filePathsError = document.getElementById('file-paths-error');
  const tierError = document.getElementById('tier-error');
  const deepArchiveNotice = document.getElementById('deep-archive-notice');
  const instantRetrievalNotice = document.getElementById('instant-retrieval-notice');
  const connectivityWarning = document.getElementById('connectivity-warning');
  const restoreDaysInput = document.getElementById('restore-days-input');
  const restoreDaysError = document.getElementById('restore-days-error');
  const destinationSelect = document.getElementById('destination-select');
  const destinationError = document.getElementById('destination-error');
  const statusFilter = document.getElementById('status-filter');
  const requestsTbody = document.getElementById('requests-tbody');
  const dashboardEmpty = document.getElementById('dashboard-empty');
  const requestsTable = document.getElementById('requests-table');

  // --- Status Classification ---
  const ERROR_STATUSES = ['Error', 'DataSync Failed', 'Restore Timed Out', 'Transfer Timed Out', 'Transfer Status Unknown'];
  const SUCCESS_STATUSES = ['Transfer Complete'];
  const WARNING_STATUSES = ['Restore Timed Out', 'Transfer Timed Out', 'Transfer Status Unknown'];
  const ACTIVE_STATUSES = ['Resolving Paths', 'Detecting Storage Class', 'Initiating Restore', 'Restore In Progress', 'Restore Complete', 'Starting DataSync', 'DataSync In Progress'];

  // --- Utility Functions ---

  /**
   * Format elapsed time from seconds into "Xd Xh Xm Xs" format,
   * omitting zero-value leading units.
   */
  function formatElapsedTime(totalSeconds) {
    if (totalSeconds < 0) totalSeconds = 0;
    totalSeconds = Math.floor(totalSeconds);

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    let started = false;

    if (days > 0) {
      parts.push(days + 'd');
      started = true;
    }
    if (hours > 0 || started) {
      if (started || hours > 0) parts.push(hours + 'h');
      started = true;
    }
    if (minutes > 0 || started) {
      if (started || minutes > 0) parts.push(minutes + 'm');
      started = true;
    }
    parts.push(seconds + 's');

    // Remove leading zero-value units
    while (parts.length > 1 && parts[0].startsWith('0')) {
      parts.shift();
    }

    return parts.join(' ');
  }

  /**
   * Format an ISO timestamp to a human-readable local date/time string.
   */
  function formatTimestamp(isoString) {
    if (!isoString) return '—';
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /**
   * Get the CSS class for a status badge based on the status value.
   */
  function getStatusBadgeClass(status) {
    if (SUCCESS_STATUSES.includes(status)) return 'status-badge--success';
    if (ERROR_STATUSES.includes(status)) return 'status-badge--error';
    if (WARNING_STATUSES.includes(status)) return 'status-badge--warning';
    if (ACTIVE_STATUSES.includes(status)) return 'status-badge--active';
    return 'status-badge--pending';
  }

  /**
   * Truncate a request ID for display.
   */
  function truncateId(id) {
    if (!id) return '—';
    if (id.length <= 12) return id;
    return id.substring(0, 12) + '…';
  }

  // --- Form Validation ---

  function clearErrors() {
    bucketError.textContent = '';
    filePathsError.textContent = '';
    tierError.textContent = '';
    restoreDaysError.textContent = '';
    destinationError.textContent = '';
    bucketInput.classList.remove('invalid');
    filePathsInput.classList.remove('invalid');
    tierSelect.classList.remove('invalid');
    restoreDaysInput.classList.remove('invalid');
    destinationSelect.classList.remove('invalid');
    formErrorGlobal.hidden = true;
    formSuccess.hidden = true;
  }

  function validateForm() {
    clearErrors();
    let valid = true;

    const bucket = bucketInput.value.trim();
    if (!bucket) {
      bucketError.textContent = 'Bucket name is required.';
      bucketInput.classList.add('invalid');
      valid = false;
    } else if (bucket.length < 3 || bucket.length > 63) {
      bucketError.textContent = 'Bucket name must be between 3 and 63 characters.';
      bucketInput.classList.add('invalid');
      valid = false;
    }

    const rawPaths = filePathsInput.value.trim();
    if (!rawPaths) {
      filePathsError.textContent = 'At least one file path is required.';
      filePathsInput.classList.add('invalid');
      valid = false;
    } else {
      const paths = parsePaths(rawPaths);
      if (paths.length === 0) {
        filePathsError.textContent = 'At least one valid file path is required.';
        filePathsInput.classList.add('invalid');
        valid = false;
      } else if (paths.length > 1000) {
        filePathsError.textContent = 'Maximum 1000 unique file paths allowed.';
        filePathsInput.classList.add('invalid');
        valid = false;
      } else {
        const tooLong = paths.find(function (p) { return p.length > 1024; });
        if (tooLong) {
          filePathsError.textContent = 'Each file path must be 1024 characters or fewer.';
          filePathsInput.classList.add('invalid');
          valid = false;
        }
      }
    }

    const tier = tierSelect.value;
    if (!['Expedited', 'Standard', 'Bulk'].includes(tier)) {
      tierError.textContent = 'Please select a valid retrieval tier.';
      tierSelect.classList.add('invalid');
      valid = false;
    }

    var restoreDays = parseInt(restoreDaysInput.value, 10);
    if (isNaN(restoreDays) || restoreDays < 1 || restoreDays > 30) {
      restoreDaysError.textContent = 'Restore duration must be between 1 and 30 days.';
      restoreDaysInput.classList.add('invalid');
      valid = false;
    }

    var destination = destinationSelect.value;
    if (!destination) {
      destinationError.textContent = 'Please select a transfer destination.';
      destinationSelect.classList.add('invalid');
      valid = false;
    }

    return valid;
  }

  /**
   * Parse textarea content into deduplicated, non-empty file paths.
   */
  function parsePaths(raw) {
    const lines = raw.split('\n');
    const seen = new Set();
    const paths = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !seen.has(line)) {
        seen.add(line);
        paths.push(line);
      }
    }
    return paths;
  }

  // --- Deep Archive / Instant Retrieval Handling ---

  /**
   * Show Deep Archive notice and disable Expedited option.
   */
  function showDeepArchiveConstraint() {
    deepArchiveNotice.hidden = false;
    instantRetrievalNotice.hidden = true;
    const expeditedOption = tierSelect.querySelector('option[value="Expedited"]');
    if (expeditedOption) {
      expeditedOption.disabled = true;
    }
    if (tierSelect.value === 'Expedited') {
      tierSelect.value = 'Standard';
    }
  }

  /**
   * Show Instant Retrieval notice.
   */
  function showInstantRetrievalNotice() {
    instantRetrievalNotice.hidden = false;
    deepArchiveNotice.hidden = true;
  }

  /**
   * Reset tier constraints to default state.
   */
  function resetTierConstraints() {
    deepArchiveNotice.hidden = true;
    instantRetrievalNotice.hidden = true;
    const expeditedOption = tierSelect.querySelector('option[value="Expedited"]');
    if (expeditedOption) {
      expeditedOption.disabled = false;
    }
  }

  // --- 401 Handling ---

  /**
   * Handle a 401 response by attempting token refresh and retrying the request.
   * If refresh fails, redirects to login.
   * @param {Function} retryFn - An async function that retries the original request with a fresh token.
   * @returns {Response|null} The retried response, or null if redirect occurred.
   */
  async function handleUnauthorized(retryFn) {
    var refreshed = await window.refreshTokens();
    if (refreshed) {
      return await retryFn();
    }
    window.redirectToLogin();
    return null;
  }

  // --- API Integration ---

  /**
   * Submit a restore request to the API.
   */
  async function submitRequest(bucket, filePaths, retrievalTier, restoreDays, destinationLocationArn) {
    var token = await window.getIdToken();
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const response = await fetch(API_BASE_URL + '/requests', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ bucket: bucket, filePaths: filePaths, retrievalTier: retrievalTier, restoreDays: restoreDays, destinationLocationArn: destinationLocationArn }),
    });

    if (response.status === 401) {
      var retryResponse = await handleUnauthorized(async function () {
        var newToken = await window.getIdToken();
        var retryHeaders = { 'Content-Type': 'application/json' };
        if (newToken) retryHeaders['Authorization'] = 'Bearer ' + newToken;
        return fetch(API_BASE_URL + '/requests', {
          method: 'POST',
          headers: retryHeaders,
          body: JSON.stringify({ bucket: bucket, filePaths: filePaths, retrievalTier: retrievalTier, restoreDays: restoreDays, destinationLocationArn: destinationLocationArn }),
        });
      });
      if (!retryResponse) return; // redirected to login
      var retryData = await retryResponse.json();
      if (!retryResponse.ok) throw new Error(retryData.message || retryData.error || 'Request failed');
      return retryData;
    }

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || data.error || 'Request failed');
    }

    return data;
  }

  /**
   * Fetch recent requests from the API.
   */
  async function fetchRequests(statusFilterValue) {
    let url = API_BASE_URL + '/requests';
    if (statusFilterValue) {
      url += '?status=' + encodeURIComponent(statusFilterValue);
    }

    var token = await window.getIdToken();
    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const response = await fetch(url, { headers: headers });

    if (response.status === 401) {
      var retryResponse = await handleUnauthorized(async function () {
        var newToken = await window.getIdToken();
        var retryHeaders = {};
        if (newToken) retryHeaders['Authorization'] = 'Bearer ' + newToken;
        return fetch(url, { headers: retryHeaders });
      });
      if (!retryResponse) return []; // redirected to login
      if (!retryResponse.ok) throw new Error('Failed to fetch requests');
      return retryResponse.json();
    }

    if (!response.ok) {
      throw new Error('Failed to fetch requests');
    }

    return response.json();
  }

  /**
   * Fetch a pre-signed URL for the manifest and open it in a new tab.
   */
  async function fetchManifestUrl(requestId) {
    try {
      var token = await window.getIdToken();
      var headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;

      var response = await fetch(API_BASE_URL + '/requests/' + encodeURIComponent(requestId) + '/manifest', { headers: headers });

      if (response.status === 401) {
        var retryResponse = await handleUnauthorized(async function () {
          var newToken = await window.getIdToken();
          var retryHeaders = {};
          if (newToken) retryHeaders['Authorization'] = 'Bearer ' + newToken;
          return fetch(API_BASE_URL + '/requests/' + encodeURIComponent(requestId) + '/manifest', { headers: retryHeaders });
        });
        if (!retryResponse) return; // redirected to login
        if (!retryResponse.ok) {
          var errData = await retryResponse.json();
          console.error('[fetchManifestUrl]', errData.error || 'Failed to get manifest URL');
          return;
        }
        var retryData = await retryResponse.json();
        if (retryData.url) window.open(retryData.url, '_blank');
        return;
      }

      if (!response.ok) {
        var errData = await response.json();
        console.error('[fetchManifestUrl]', errData.error || 'Failed to get manifest URL');
        return;
      }
      var data = await response.json();
      if (data.url) {
        window.open(data.url, '_blank');
      }
    } catch (err) {
      console.error('[fetchManifestUrl]', err.message);
    }
  }

  // --- Form Submission ---

  async function handleSubmit(event) {
    event.preventDefault();

    if (!validateForm()) return;

    const bucket = bucketInput.value.trim();
    const filePaths = parsePaths(filePathsInput.value.trim());
    const retrievalTier = tierSelect.value;
    const restoreDays = parseInt(restoreDaysInput.value, 10);
    const destinationLocationArn = destinationSelect.value;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    clearErrors();

    try {
      const result = await submitRequest(bucket, filePaths, retrievalTier, restoreDays, destinationLocationArn);
      formSuccess.textContent = 'Request submitted successfully. Request ID: ' + (result.requestId || 'N/A');
      formSuccess.hidden = false;
      form.reset();
      tierSelect.value = 'Standard';
      restoreDaysInput.value = '7';
      resetTierConstraints();
      // Restore the destination select to its current selection (don't reset it)
      if (destinationSelect.options.length > 0) {
        destinationSelect.selectedIndex = 0;
      }
      // Refresh the dashboard immediately
      await refreshDashboard();
    } catch (err) {
      formErrorGlobal.textContent = 'Error: ' + err.message;
      formErrorGlobal.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Restore Request';
    }
  }

  // --- Dashboard Rendering ---

  function renderDashboard() {
    const filterValue = statusFilter.value;
    const filtered = filterValue
      ? requests.filter(function (r) { return r.status === filterValue; })
      : requests;

    if (filtered.length === 0) {
      dashboardEmpty.hidden = false;
      requestsTable.hidden = true;
      return;
    }

    dashboardEmpty.hidden = true;
    requestsTable.hidden = false;

    requestsTbody.innerHTML = '';

    for (let i = 0; i < filtered.length; i++) {
      var req = filtered[i];
      var row = document.createElement('tr');

      // Request ID
      var tdId = document.createElement('td');
      tdId.title = req.requestId || '';
      tdId.textContent = truncateId(req.requestId);
      row.appendChild(tdId);

      // Bucket
      var tdBucket = document.createElement('td');
      tdBucket.textContent = req.bucket || '—';
      row.appendChild(tdBucket);

      // Status
      var tdStatus = document.createElement('td');
      var badge = document.createElement('span');
      badge.className = 'status-badge ' + getStatusBadgeClass(req.status);
      badge.textContent = req.status || 'Unknown';
      tdStatus.appendChild(badge);
      row.appendChild(tdStatus);

      // Objects
      var tdObjects = document.createElement('td');
      var restored = req.restoredCount || 0;
      var total = req.objectCount || 0;
      if (total === 0 && !ERROR_STATUSES.includes(req.status) && req.status !== 'Transfer Complete') {
        tdObjects.textContent = 'Resolving…';
      } else {
        tdObjects.textContent = restored + '/' + total;
      }
      row.appendChild(tdObjects);

      // Submitted
      var tdSubmitted = document.createElement('td');
      tdSubmitted.textContent = formatTimestamp(req.submittedAt);
      row.appendChild(tdSubmitted);

      // Elapsed Time
      var tdElapsed = document.createElement('td');
      tdElapsed.className = 'elapsed-time';
      tdElapsed.setAttribute('data-submitted-at', req.submittedAt || '');
      tdElapsed.setAttribute('data-completed-at', req.completedAt || '');
      tdElapsed.textContent = computeElapsed(req.submittedAt, req.completedAt);
      row.appendChild(tdElapsed);

      // Make row clickable for detail view
      row.classList.add('clickable-row');
      row.setAttribute('data-request-id', req.requestId || '');
      row.addEventListener('click', function () {
        openRequestDetail(this.getAttribute('data-request-id'));
      });

      requestsTbody.appendChild(row);
    }
  }

  /**
   * Compute elapsed time string from a submitted timestamp.
   * If completedAt is provided, uses that as the end time (fixed duration).
   * Otherwise uses current time (live counter).
   */
  function computeElapsed(submittedAt, completedAt) {
    if (!submittedAt) return '—';
    var submitted = new Date(submittedAt).getTime();
    if (isNaN(submitted)) return '—';
    var endTime;
    if (completedAt) {
      endTime = new Date(completedAt).getTime();
      if (isNaN(endTime)) endTime = Date.now();
    } else {
      endTime = Date.now();
    }
    var elapsedSeconds = Math.floor((endTime - submitted) / 1000);
    return formatElapsedTime(elapsedSeconds);
  }

  /**
   * Update all elapsed time cells without re-rendering the full table.
   * Skips cells that have a completedAt (their elapsed time is fixed).
   */
  function updateElapsedTimes() {
    var cells = document.querySelectorAll('.elapsed-time');
    for (var i = 0; i < cells.length; i++) {
      var completedAt = cells[i].getAttribute('data-completed-at');
      if (completedAt) continue; // already finalized, no need to update
      var submittedAt = cells[i].getAttribute('data-submitted-at');
      cells[i].textContent = computeElapsed(submittedAt, null);
    }
  }

  // --- Dashboard Refresh ---

  async function refreshDashboard() {
    try {
      var filterValue = statusFilter.value;
      var data = await fetchRequests(filterValue);
      requests = Array.isArray(data) ? data : (data.requests || []);
      lastSuccessfulFetch = Date.now();
      hideConnectivityWarning();
      renderDashboard();
    } catch (err) {
      checkConnectivity();
    }
  }

  // --- Connectivity Warning ---

  function checkConnectivity() {
    var elapsed = Date.now() - lastSuccessfulFetch;
    if (elapsed >= CONNECTIVITY_TIMEOUT_MS && !connectivityWarningVisible) {
      showConnectivityWarning();
    }
  }

  function showConnectivityWarning() {
    connectivityWarning.hidden = false;
    connectivityWarning.classList.add('visible');
    connectivityWarningVisible = true;
  }

  function hideConnectivityWarning() {
    connectivityWarning.hidden = true;
    connectivityWarning.classList.remove('visible');
    connectivityWarningVisible = false;
  }

  // --- DataSync Destinations ---

  /**
   * Fetch available DataSync NFS destinations from the API and populate the select dropdown.
   */
  async function fetchDestinations() {
    try {
      var token = await window.getIdToken();
      var headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;

      var response = await fetch(API_BASE_URL + '/datasync-destinations', { headers: headers });

      if (response.status === 401) {
        var retryResponse = await handleUnauthorized(async function () {
          var newToken = await window.getIdToken();
          var retryHeaders = {};
          if (newToken) retryHeaders['Authorization'] = 'Bearer ' + newToken;
          return fetch(API_BASE_URL + '/datasync-destinations', { headers: retryHeaders });
        });
        if (!retryResponse) return;
        if (!retryResponse.ok) throw new Error('Failed to fetch destinations');
        var retryData = await retryResponse.json();
        populateDestinations(retryData.destinations || []);
        return;
      }

      if (!response.ok) throw new Error('Failed to fetch destinations');
      var data = await response.json();
      populateDestinations(data.destinations || []);
    } catch (err) {
      console.error('[fetchDestinations]', err.message);
      destinationSelect.innerHTML = '';
      var errorOpt = document.createElement('option');
      errorOpt.value = '';
      errorOpt.textContent = 'Failed to load destinations';
      destinationSelect.appendChild(errorOpt);
    }
  }

  /**
   * Populate the destination dropdown with options.
   */
  function populateDestinations(destinations) {
    destinationSelect.innerHTML = '';

    if (destinations.length === 0) {
      var emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = 'No destinations available';
      destinationSelect.appendChild(emptyOpt);
      return;
    }

    for (var i = 0; i < destinations.length; i++) {
      var dest = destinations[i];
      var opt = document.createElement('option');
      opt.value = dest.locationArn;
      // Display the location URI (e.g., nfs://server/export/path)
      opt.textContent = dest.locationUri;
      destinationSelect.appendChild(opt);
    }
  }

  // --- Initialization ---

  async function init() {
    // Authenticate first — halt if user is being redirected to login
    var authenticated = await window.initAuth();
    if (!authenticated) return;

    // Display authenticated user's email in the header
    var userEmail = window.getUserEmail();
    var userEmailEl = document.getElementById('user-email');
    var userInfoEl = document.getElementById('user-info');
    if (userEmail && userEmailEl && userInfoEl) {
      userEmailEl.textContent = userEmail;
      userInfoEl.hidden = false;
    }

    // Wire logout button
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) logoutBtn.addEventListener('click', window.logout);

    // Load available DataSync destinations
    await fetchDestinations();

    // Form submission
    form.addEventListener('submit', handleSubmit);

    // Status filter change
    statusFilter.addEventListener('change', renderDashboard);

    // Start polling for status updates
    refreshDashboard();
    statusPollTimer = setInterval(refreshDashboard, STATUS_POLL_INTERVAL_MS);

    // Start elapsed time updates
    elapsedTimeTimer = setInterval(updateElapsedTimes, ELAPSED_TIME_UPDATE_MS);
  }

  // --- Request Detail Panel ---

  /**
   * Fetch full request detail and show the timeline panel.
   */
  async function openRequestDetail(requestId) {
    if (!requestId) return;

    try {
      var token = await window.getIdToken();
      var headers = {};
      if (token) headers['Authorization'] = 'Bearer ' + token;

      var response = await fetch(API_BASE_URL + '/requests/' + encodeURIComponent(requestId), { headers: headers });

      if (response.status === 401) {
        var retryResponse = await handleUnauthorized(async function () {
          var newToken = await window.getIdToken();
          var retryHeaders = {};
          if (newToken) retryHeaders['Authorization'] = 'Bearer ' + newToken;
          return fetch(API_BASE_URL + '/requests/' + encodeURIComponent(requestId), { headers: retryHeaders });
        });
        if (!retryResponse) return; // redirected to login
        if (!retryResponse.ok) throw new Error('Failed to fetch request detail');
        var retryDetail = await retryResponse.json();
        showDetailPanel(retryDetail);
        return;
      }

      if (!response.ok) throw new Error('Failed to fetch request detail');
      var detail = await response.json();
      showDetailPanel(detail);
    } catch (err) {
      console.error('[openRequestDetail]', err.message);
    }
  }

  /**
   * Render the detail panel overlay with status timeline.
   */
  function showDetailPanel(detail) {
    // Remove existing panel if open
    var existing = document.getElementById('detail-panel');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'detail-panel';
    overlay.className = 'detail-overlay';
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) overlay.remove();
    });

    var panel = document.createElement('div');
    panel.className = 'detail-panel';

    // Header
    var header = document.createElement('div');
    header.className = 'detail-header';
    var headerTitle = document.createElement('h3');
    headerTitle.textContent = 'Request Detail';
    header.appendChild(headerTitle);
    var closeBtn = document.createElement('button');
    closeBtn.className = 'detail-close';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close detail panel');
    closeBtn.addEventListener('click', function () { overlay.remove(); });
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Summary
    var summary = document.createElement('div');
    summary.className = 'detail-summary';

    function createDetailField(label, value) {
      var field = document.createElement('div');
      field.className = 'detail-field';
      var labelSpan = document.createElement('span');
      labelSpan.className = 'detail-label';
      labelSpan.textContent = label;
      var valueSpan = document.createElement('span');
      valueSpan.className = 'detail-value';
      valueSpan.textContent = value;
      field.appendChild(labelSpan);
      field.appendChild(valueSpan);
      return field;
    }

    function createDetailFieldWithBadge(label, statusText, badgeClass) {
      var field = document.createElement('div');
      field.className = 'detail-field';
      var labelSpan = document.createElement('span');
      labelSpan.className = 'detail-label';
      labelSpan.textContent = label;
      var valueSpan = document.createElement('span');
      valueSpan.className = 'detail-value';
      var badge = document.createElement('span');
      badge.className = 'status-badge ' + badgeClass;
      badge.textContent = statusText;
      valueSpan.appendChild(badge);
      field.appendChild(labelSpan);
      field.appendChild(valueSpan);
      return field;
    }

    summary.appendChild(createDetailField('Request ID', detail.requestId || '—'));
    summary.appendChild(createDetailField('Bucket', detail.bucket || '—'));
    summary.appendChild(createDetailFieldWithBadge('Status', detail.status || 'Unknown', getStatusBadgeClass(detail.status)));
    summary.appendChild(createDetailField('Retrieval Tier', detail.retrievalTier || '—'));
    summary.appendChild(createDetailField('Restore Duration', detail.restoreDays ? detail.restoreDays + ' days' : '—'));
    summary.appendChild(createDetailField('Destination', detail.destinationLocationArn || 'Default'));
    summary.appendChild(createDetailField('Objects', (detail.restoredCount || 0) + ' / ' + (detail.objectCount || 0)));
    summary.appendChild(createDetailField('Submitted', formatTimestamp(detail.submittedAt)));
    if (detail.restoreExpiresAt) {
      summary.appendChild(createDetailField('Restore Expires', formatTimestamp(detail.restoreExpiresAt)));
    }
    if (detail.completedAt) {
      summary.appendChild(createDetailField('Completed', formatTimestamp(detail.completedAt)));
    }
    panel.appendChild(summary);

    // Timeline
    var timelineSection = document.createElement('div');
    timelineSection.className = 'detail-timeline-section';
    var timelineHeading = document.createElement('h4');
    timelineHeading.textContent = 'Status Timeline';
    timelineSection.appendChild(timelineHeading);

    var history = detail.statusHistory || [];
    if (history.length === 0) {
      var noHistory = document.createElement('p');
      noHistory.className = 'detail-no-history';
      noHistory.textContent = 'No status history available.';
      timelineSection.appendChild(noHistory);
    } else {
      var timeline = document.createElement('div');
      timeline.className = 'detail-timeline';

      for (var i = 0; i < history.length; i++) {
        var entry = history[i];
        var item = document.createElement('div');
        item.className = 'timeline-item';

        var dot = document.createElement('div');
        dot.className = 'timeline-dot ' + getStatusBadgeClass(entry.status);
        item.appendChild(dot);

        var content = document.createElement('div');
        content.className = 'timeline-content';

        var statusLabel = document.createElement('span');
        statusLabel.className = 'timeline-status';
        statusLabel.textContent = entry.status;
        content.appendChild(statusLabel);

        var timeLabel = document.createElement('span');
        timeLabel.className = 'timeline-time';
        timeLabel.textContent = formatTimestamp(entry.timestamp);
        content.appendChild(timeLabel);

        // Show duration between steps
        if (i > 0 && entry.timestamp && history[i - 1].timestamp) {
          var prevTime = new Date(history[i - 1].timestamp).getTime();
          var currTime = new Date(entry.timestamp).getTime();
          var durationSec = Math.floor((currTime - prevTime) / 1000);
          if (durationSec > 0) {
            var durationLabel = document.createElement('span');
            durationLabel.className = 'timeline-duration';
            durationLabel.textContent = '+ ' + formatElapsedTime(durationSec);
            content.appendChild(durationLabel);
          }
        }

        item.appendChild(content);
        timeline.appendChild(item);
      }

      timelineSection.appendChild(timeline);
    }

    panel.appendChild(timelineSection);

    // File list
    if (detail.filePaths && detail.filePaths.length > 0) {
      var filesSection = document.createElement('div');
      filesSection.className = 'detail-files-section';
      var filesHeading = document.createElement('h4');
      filesHeading.textContent = 'Objects (' + detail.filePaths.length + ')';
      filesSection.appendChild(filesHeading);

      if (detail.filePaths.length >= 50 && detail.manifestKey) {
        // Large request with manifest — show download link instead of full list
        var manifestNote = document.createElement('p');
        manifestNote.className = 'detail-manifest-note';
        manifestNote.textContent = 'This request contains ' + detail.filePaths.length + ' objects. Download the manifest to view the full list.';
        filesSection.appendChild(manifestNote);

        var downloadBtn = document.createElement('button');
        downloadBtn.className = 'btn btn-manifest';
        downloadBtn.textContent = 'Download Manifest CSV';
        downloadBtn.addEventListener('click', function () {
          fetchManifestUrl(detail.requestId);
        });
        filesSection.appendChild(downloadBtn);
      } else {
        // Small request — show inline list
        var fileList = document.createElement('ul');
        fileList.className = 'detail-file-list';

        for (var f = 0; f < detail.filePaths.length; f++) {
          var fileItem = document.createElement('li');
          fileItem.className = 'detail-file-item';
          fileItem.textContent = detail.filePaths[f];
          fileList.appendChild(fileItem);
        }

        filesSection.appendChild(fileList);
      }

      panel.appendChild(filesSection);
    }

    // Error reason (high-level)
    if (detail.errorReason) {
      var reasonSection = document.createElement('div');
      reasonSection.className = 'detail-errors-section';
      var reasonHeading = document.createElement('h4');
      reasonHeading.textContent = 'Error';
      reasonSection.appendChild(reasonHeading);
      var reasonText = document.createElement('p');
      reasonText.className = 'detail-error-reason-summary';
      reasonText.textContent = detail.errorReason;
      reasonSection.appendChild(reasonText);
      panel.appendChild(reasonSection);
    } else if (ERROR_STATUSES.includes(detail.status) && detail.objectCount === 0 && (!detail.errorDetails || detail.errorDetails.length === 0)) {
      var reasonSection = document.createElement('div');
      reasonSection.className = 'detail-errors-section';
      var reasonHeading = document.createElement('h4');
      reasonHeading.textContent = 'Error';
      reasonSection.appendChild(reasonHeading);
      var reasonText = document.createElement('p');
      reasonText.className = 'detail-error-reason-summary';
      reasonText.textContent = 'No objects found matching the specified paths';
      reasonSection.appendChild(reasonText);
      panel.appendChild(reasonSection);
    }

    // Per-file error details
    if (detail.errorDetails && detail.errorDetails.length > 0) {
      var errSection = document.createElement('div');
      errSection.className = 'detail-errors-section';
      var errHeading = document.createElement('h4');
      errHeading.textContent = 'Error Details';
      errSection.appendChild(errHeading);

      for (var j = 0; j < detail.errorDetails.length; j++) {
        var err = detail.errorDetails[j];
        var errItem = document.createElement('div');
        errItem.className = 'detail-error-item';
        var errStep = document.createElement('span');
        errStep.className = 'detail-error-step';
        errStep.textContent = err.step || 'Unknown';
        var errReason = document.createElement('span');
        errReason.className = 'detail-error-reason';
        errReason.textContent = err.reason || 'Unknown error';
        var errTime = document.createElement('span');
        errTime.className = 'detail-error-time';
        errTime.textContent = formatTimestamp(err.timestamp);
        errItem.appendChild(errStep);
        errItem.appendChild(errReason);
        errItem.appendChild(errTime);
        errSection.appendChild(errItem);
      }

      panel.appendChild(errSection);
    }

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  // Expose formatElapsedTime for testing
  window.formatElapsedTime = formatElapsedTime;

  // Expose functions for Deep Archive / Instant Retrieval handling
  window.showDeepArchiveConstraint = showDeepArchiveConstraint;
  window.showInstantRetrievalNotice = showInstantRetrievalNotice;
  window.resetTierConstraints = resetTierConstraints;

  // Start the app when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
