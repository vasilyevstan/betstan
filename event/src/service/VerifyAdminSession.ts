import http from "http";
import https from "https";
import { Request } from "express";

const VERIFICATION_TIMEOUT_MS = 3000;

export type AdminVerificationStatus = 204 | 401 | 403;
export type AdminSessionVerifier = (
  cookieHeader: string
) => Promise<AdminVerificationStatus>;

const verifyAdminSessionOverHttp: AdminSessionVerifier = (cookieHeader) => {
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
    const verificationRequest = transport.request(
      url,
      {
        method: "GET",
        headers: { Cookie: cookieHeader },
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

    verificationRequest.on("timeout", () => {
      verificationRequest.destroy(new Error("Auth verification timed out"));
    });
    verificationRequest.on("error", reject);
    verificationRequest.end();
  });
};

export const verifyAdminSession = verifyAdminSessionOverHttp;
let sessionVerifier: AdminSessionVerifier = verifyAdminSessionOverHttp;

export const setAdminSessionVerifierForTests = (
  verifier: AdminSessionVerifier
) => {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Admin session verifier can only be replaced in tests");
  }
  sessionVerifier = verifier;
};

export const verifyAdminRequest = async (
  req: Request
): Promise<AdminVerificationStatus> => {
  if (!req.currentUser) {
    return 401;
  }
  const role = (
    req.currentUser as typeof req.currentUser & { role?: string }
  ).role;
  if (role !== "ADMIN") {
    return 403;
  }

  return sessionVerifier(req.headers.cookie ?? "");
};
