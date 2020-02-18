import { HWTokenManager } from "./canokey";
import { OTPEntry } from "./otp";

(<any>window)['HWTokenManager'] = HWTokenManager;
(<any>window)['OTPEntry'] = OTPEntry;