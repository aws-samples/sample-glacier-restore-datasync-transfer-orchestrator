/**
 * GET /requests/{requestId}/manifest API handler.
 *
 * Returns a pre-signed URL for downloading the batch restore manifest CSV
 * from the staging bucket. The URL is valid for 15 minutes.
 */

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getRequestRecord } from "../orchestrator/utils/status";

const s3Client = new S3Client({});

/** Standard CORS headers for all responses */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

/** Pre-signed URL expiration in seconds (15 minutes) */
const PRESIGN_EXPIRATION_SECONDS = 900;

export async function handler(
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const requestId = event.pathParameters?.requestId;

  if (!requestId) {
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Missing requestId path parameter" }),
    };
  }

  const stagingBucket = process.env.STAGING_BUCKET;
  if (!stagingBucket) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Staging bucket not configured" }),
    };
  }

  try {
    const record = await getRequestRecord(requestId);

    if (!record) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Request not found" }),
      };
    }

    if (!record.manifestKey) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "No manifest available for this request. Manifests are only created for batch operations (≥50 objects).",
        }),
      };
    }

    // Generate a pre-signed URL for the manifest
    const command = new GetObjectCommand({
      Bucket: stagingBucket,
      Key: record.manifestKey,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: PRESIGN_EXPIRATION_SECONDS,
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        url: presignedUrl,
        manifestKey: record.manifestKey,
        expiresInSeconds: PRESIGN_EXPIRATION_SECONDS,
      }),
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: message }),
    };
  }
}
