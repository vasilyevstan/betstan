import mongoose from "mongoose";
import { deleteUserById } from "../service/DeleteUser";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }

  return value;
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
