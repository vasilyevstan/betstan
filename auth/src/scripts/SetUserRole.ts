import mongoose from "mongoose";
import { User, UserRole } from "../model/User";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }

  return value;
}

async function setUserRole() {
  const mongoUri = requiredEnv("MONGO_URI");
  const userId = requiredEnv("USER_ID");
  const roleValue = requiredEnv("USER_ROLE");
  const confirmation = requiredEnv("USER_ROLE_CHANGE_CONFIRMATION");

  if (!mongoose.isValidObjectId(userId)) {
    throw new Error("USER_ID must be a valid MongoDB object ID");
  }

  if (!Object.values(UserRole).includes(roleValue as UserRole)) {
    throw new Error("USER_ROLE must be USER or ADMIN");
  }

  if (confirmation !== `SET_ROLE:${userId}:${roleValue}`) {
    throw new Error(
      "USER_ROLE_CHANGE_CONFIRMATION does not match the requested change"
    );
  }

  await mongoose.connect(mongoUri);
  const result = await User.updateOne(
    { _id: userId },
    { $set: { role: roleValue as UserRole } }
  );

  if (result.matchedCount !== 1) {
    throw new Error("User was not found");
  }

  console.log(`Updated role for user ${userId}`);
}

setUserRole()
  .then(async () => {
    await mongoose.disconnect();
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : "Role update failed");
    await mongoose.disconnect();
    process.exitCode = 1;
  });
