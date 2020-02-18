
export enum OTPType {
  totp = 1,
  hotp,
}

export enum OTPAlgorithm {
  SHA1 = 1,
  SHA256,
}

export class OTPEntry {
  type: OTPType;
  index: number;
  issuer: string;
  secret: string | null;
  account: string;
  counter: number;
  period: number;
  digits: number;
  algorithm: OTPAlgorithm;
  code = "&bull;&bull;&bull;&bull;&bull;&bull;";

  constructor(
    entry: {
      account?: string;
      index: number;
      issuer?: string;
      secret: string;
      type: OTPType;
      counter?: number;
      period?: number;
      hash?: string;
      digits?: number;
      algorithm?: OTPAlgorithm;
    },
  ) {
    this.type = entry.type;
    this.index = entry.index;
    if (entry.issuer) {
      this.issuer = entry.issuer;
    } else {
      this.issuer = "";
    }
    if (entry.account) {
      this.account = entry.account;
    } else {
      this.account = "";
    }
    this.secret = entry.secret;
    if (entry.counter) {
      this.counter = entry.counter;
    } else {
      this.counter = 0;
    }
    if (entry.digits) {
      this.digits = entry.digits;
    } else {
      this.digits = 6;
    }
    if (entry.algorithm) {
      this.algorithm = entry.algorithm;
    } else {
      this.algorithm = OTPAlgorithm.SHA1;
    }
    if (this.type === OTPType.totp && entry.period) {
      this.period = entry.period;
    } else {
      this.period = 30;
    }
    if (this.type !== OTPType.hotp) {
      this.generate();
    }
  }

  async next() {
    if (this.type !== OTPType.hotp) {
      return;
    }
    this.generate();
    return;
  }

  async generate() {
  }
}
