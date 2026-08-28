import mongoose from "mongoose";
import { User } from "../model/User";

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
