import mongoose from "mongoose";
import { User } from "../model/User";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }

  return value;
}

export async function deleteUserById(
  userId: string,
  email: string,
  confirmation: string
): Promise<void> {
  if (!mongoose.isValidObjectId(userId)) {
    throw new Error("USER_ID must be a valid MongoDB object ID");
  }

  if (!/^live-e2e-[0-9]+$/.test(email)) {
    throw new Error("USER_EMAIL must identify a disposable live-e2e account");
  }

  if (confirmation !== `DELETE_USER:${userId}:${email}`) {
    throw new Error(
      "USER_DELETE_CONFIRMATION does not match the requested deletion"
    );
  }

  const result = await User.deleteOne({
    _id: userId,
    email,
    identifierNormalized: email,
  });
  if (result.deletedCount !== 1) {
    throw new Error("User was not found");
  }
}

async function deleteUser(): Promise<void> {
  const mongoUri = requiredEnv("MONGO_URI");
  const userId = requiredEnv("USER_ID");
  const email = requiredEnv("USER_EMAIL");
  const confirmation = requiredEnv("USER_DELETE_CONFIRMATION");

  await mongoose.connect(mongoUri);
  await deleteUserById(userId, email, confirmation);
  console.log(`Deleted user ${userId}`);
}

if (require.main === module) {
  deleteUser()
    .then(async () => {
      await mongoose.disconnect();
    })
    .catch(async (error) => {
      console.error(
        error instanceof Error ? error.message : "User deletion failed"
      );
      await mongoose.disconnect();
      process.exitCode = 1;
    });
}
