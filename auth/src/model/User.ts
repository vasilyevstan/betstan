import { Schema, model } from "mongoose";
import { Password } from "../service/Password";

enum UserRole {
  USER = "USER",
  ADMIN = "ADMIN",
}

const userSchema = new Schema({
  email: {
    type: String,
    required: true,
  },
  identifierNormalized: {
    type: String,
    required: false,
  },
  password: {
    type: String,
    required: true,
  },
  role: {
    type: String,
    enum: Object.values(UserRole),
    required: true,
    default: UserRole.USER,
  },
  timestamp: {
    type: String,
    required: false,
  },
  lastLogin: {
    type: String,
    required: false,
  },
});

userSchema.index(
  { identifierNormalized: 1 },
  {
    unique: true,
    partialFilterExpression: {
      identifierNormalized: { $type: "string" },
    },
  }
);

userSchema.set("toJSON", {
  transform: (_document, returnedObject) => {
    return {
      _id: returnedObject._id,
      email: returnedObject.email,
      role: returnedObject.role,
      timestamp: returnedObject.timestamp,
      lastLogin: returnedObject.lastLogin,
    };
  },
});

userSchema.pre("save", async function (done) {
  if (this.isModified("password")) {
    const hashedPassword = await Password.toHash(this.get("password"));

    this.set("password", hashedPassword);
  }

  done();
});

const User = model("User", userSchema);

export { User, UserRole };
