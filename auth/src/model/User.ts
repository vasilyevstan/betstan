import { Schema, model } from "mongoose";
import { Password } from "../service/Password";

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
    delete returnedObject.password;
    delete returnedObject.identifierNormalized;
    delete returnedObject.__v;
    return returnedObject;
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

export { User };
