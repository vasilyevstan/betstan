import { Schema, model } from "mongoose";

// One platform-wide document. A missing document or field means "open".
export const ACCESS_CONTROL_ID = "platform";
export const accessSwitchFields = {
  registration: "registrationEnabled",
  login: "loginEnabled",
} as const;
export type AccessSwitch = keyof typeof accessSwitchFields;

export type AccessControlState = {
  registrationEnabled: boolean;
  loginEnabled: boolean;
  revision: number;
  updatedAt?: Date;
};

const accessControlSchema = new Schema(
  {
    _id: { type: String, required: true },
    registrationEnabled: { type: Boolean },
    loginEnabled: { type: Boolean },
    revision: { type: Number, default: 0 },
    updatedAt: { type: Date },
  },
  { versionKey: false }
);

export const AccessControl = model("AccessControl", accessControlSchema);

export const toAccessControlState = (document: any): AccessControlState => ({
  registrationEnabled: document?.registrationEnabled !== false,
  loginEnabled: document?.loginEnabled !== false,
  revision: Number.isSafeInteger(document?.revision) ? document.revision : 0,
  ...(document?.updatedAt instanceof Date ? { updatedAt: document.updatedAt } : {}),
});

export const readAccessControls = async (): Promise<AccessControlState> =>
  toAccessControlState(await AccessControl.findById(ACCESS_CONTROL_ID).lean());
