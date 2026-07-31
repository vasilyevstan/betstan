type PublicUserSource = {
  _id: unknown;
  email: string;
};

export const usernamePattern = /^[A-Za-z0-9][A-Za-z0-9._%+@-]*$/;

export const normalizeIdentifier = (identifier: string) =>
  identifier.trim().toLowerCase();

export const toPublicUser = (user: PublicUserSource) => ({
  id: String(user._id),
  email: user.email,
});

export const isDuplicateKeyError = (error: unknown) =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === 11000;
