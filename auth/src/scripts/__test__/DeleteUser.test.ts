import mongoose from "mongoose";
import { User, UserRole } from "../../model/User";
import { deleteUserById } from "../DeleteUser";

async function createUser() {
  return User.create({
    email: "live-e2e-123",
    identifierNormalized: "live-e2e-123",
    password: "password",
    role: UserRole.ADMIN,
  });
}

it("deletes only the exactly confirmed user", async () => {
  const user = await createUser();

  await deleteUserById(
    user.id,
    user.email,
    `DELETE_USER:${user.id}:${user.email}`
  );

  await expect(User.findById(user.id)).resolves.toBeNull();
});

it("rejects a mismatched deletion confirmation", async () => {
  const user = await createUser();

  await expect(
    deleteUserById(
      user.id,
      user.email,
      `DELETE_USER:${new mongoose.Types.ObjectId()}:${user.email}`
    )
  ).rejects.toThrow(
    "USER_DELETE_CONFIRMATION does not match the requested deletion"
  );
  await expect(User.findById(user.id)).resolves.not.toBeNull();
});

it("rejects an invalid user ID without deleting another user", async () => {
  const user = await createUser();

  await expect(
    deleteUserById("invalid", user.email, `DELETE_USER:invalid:${user.email}`)
  ).rejects.toThrow("USER_ID must be a valid MongoDB object ID");
  await expect(User.findById(user.id)).resolves.not.toBeNull();
});

it("rejects an account outside the reserved live-e2e namespace", async () => {
  const user = await createUser();
  const email = "ordinary-user";

  await expect(
    deleteUserById(user.id, email, `DELETE_USER:${user.id}:${email}`)
  ).rejects.toThrow("USER_EMAIL must identify a disposable live-e2e account");
  await expect(User.findById(user.id)).resolves.not.toBeNull();
});

it("rejects a different live-e2e account identity", async () => {
  const user = await createUser();
  const email = "live-e2e-456";

  await expect(
    deleteUserById(user.id, email, `DELETE_USER:${user.id}:${email}`)
  ).rejects.toThrow("User was not found");
  await expect(User.findById(user.id)).resolves.not.toBeNull();
});

it("fails when the exactly confirmed user no longer exists", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const email = "live-e2e-123";

  await expect(
    deleteUserById(userId, email, `DELETE_USER:${userId}:${email}`)
  ).rejects.toThrow("User was not found");
});
