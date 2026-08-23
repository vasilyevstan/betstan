import http from "http";
import https from "https";

const VERIFICATION_TIMEOUT_MS = 3000;

export type AdminVerificationStatus = 204 | 401 | 403;
export type AdminSessionVerifier = (
  cookieHeader: string
) => Promise<AdminVerificationStatus>;

export const verifyAdminSession: AdminSessionVerifier = (cookieHeader) => {
  const serviceUrl = process.env.AUTH_SERVICE_URL;
  if (!serviceUrl) {
    return Promise.reject(new Error("AUTH_SERVICE_URL is not configured"));
  }

  const url = new URL("/api/auth/admin/verify", serviceUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error("AUTH_SERVICE_URL must use HTTP or HTTPS"));
  }

  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "GET",
        headers: {
          Cookie: cookieHeader,
        },
        timeout: VERIFICATION_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        const status = response.statusCode;
        if (status === 204 || status === 401 || status === 403) {
          resolve(status);
          return;
        }

        reject(new Error(`Unexpected auth verification status ${status}`));
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Auth verification timed out"));
    });
    request.on("error", reject);
    request.end();
  });
};
