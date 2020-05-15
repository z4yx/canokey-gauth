import { OTPType, OTPAlgorithm, OTPEntry } from "./otp";

export enum SpecialCode {
  hotpNoResponse = -2,
  touchRequired = -1
}

export class Canokey {
  device: USBDevice | undefined;
  utf8Decoder = new TextDecoder("utf-8");
  utf8Encoder = new TextEncoder();
  private transceiveLock = false;

  isConnected() {
    return this.device instanceof USBDevice && this.device.opened;
  }

  static base32ToHex(base32: string) {
    let base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    let hex = "";

    for (let i = 0; i < base32.length; i++) {
      let val = base32chars.indexOf(base32.charAt(i).toUpperCase());
      bits += Canokey.leftpad(val.toString(2), 5, '0');
    }

    for (let i = 0; i + 4 <= bits.length; i += 4) {
      let chunk = bits.substr(i, 4);
      hex = hex + parseInt(chunk, 2).toString(16);
    }

    return hex;
  };

  static leftpad(str: string, len: number, pad: string) {
    if (len + 1 >= str.length) {
      str = new Array(len + 1 - str.length).join(pad) + str;
    }
    return str;
  };

  static byteToHexString(uint8arr: Uint8Array) {
    if (!uint8arr) return "";
    var hexStr = "";
    for (var i = 0; i < uint8arr.length; i++) {
      var hex = (uint8arr[i] & 0xff).toString(16);
      hex = hex.length === 1 ? "0" + hex : hex;
      hexStr += hex;
    }
    return hexStr.toUpperCase();
  }

  static hexStringToByte(str: String) {
    if (!str) return new Uint8Array(0);
    var a = [];
    for (var i = 0, len = str.length; i < len; i += 2)
      a.push(parseInt(str.substr(i, 2), 16));
    return new Uint8Array(a);
  }

  static async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async transceive(capdu: String) {
    console.debug("APDU --->", capdu);
    if (!this.device) throw new Error("Device not connected");
    if (this.transceiveLock) throw new Error("Another APDU on-going");
    this.transceiveLock = true;
    try {
      let data = Canokey.hexStringToByte(capdu);
      // send a command
      // console.debug('to s', this.device, reshapedData);
      let respCmd = await this.device.controlTransferOut(
        {
          requestType: "vendor",
          recipient: "interface",
          request: 0,
          value: 0,
          index: 1
        },
        data
      );
      console.debug('sent', respCmd);
      // wait for execution
      for (let retry = 0; ; retry++) {
        let respWait = await this.device.controlTransferIn(
          {
            requestType: "vendor",
            recipient: "interface",
            request: 2,
            value: 0,
            index: 1
          },
          1
        );
        console.debug('wait', respWait);
        if (!respWait.data || respWait.data.byteLength === 0) throw new Error("Empty data from the device");
        console.debug('state qry', respWait.data.byteLength, respWait.data.getUint8(0));
        if (respWait.data.getUint8(0) == 0) break;
        if (retry >= 5) throw new Error("Device timeout");
        await Canokey.sleep(100);
      }
      // get the response
      let resp = await this.device.controlTransferIn(
        {
          requestType: "vendor",
          recipient: "interface",
          request: 1,
          value: 0,
          index: 1
        },
        1500
      );
      if (resp.status === "ok") {
        if (!resp.data) throw new Error("Empty data from the device");
        let rx = Canokey.byteToHexString(new Uint8Array(resp.data.buffer));
        console.debug("APDU <---", rx);
        return rx;
      }
      return "";

    } catch (E) {
      throw E;
    } finally {
      this.transceiveLock = false;
    }
  }
  async connectToDevice() {
    try {
      let authorized_devices = await navigator.usb.getDevices();
      if (authorized_devices.length > 0) {
        this.device = authorized_devices[0];
      }
    } catch (err1) {
      console.warn("getDevices failed:", err1);
      return;
    }
    if (this.device === undefined) {
      try {
        this.device = await navigator.usb.requestDevice({
          filters: [
            {
              classCode: 0xff // vendor-specific
            }
          ]
        });
        console.debug(this.device);
        if (this.device === undefined) {
          throw new Error("requestDevice returns undefined");
        }
      } catch (err) {
        console.warn("requestDevice failed:", err);
        return;
      }
    }

    try {
      await this.device.open();
      console.debug(this.device.configurations);
      await Canokey.sleep(100);
      if (this.device.configuration === null)
        await this.device.selectConfiguration(1);
      await this.device.claimInterface(1);
    } catch (err) {
      console.error("Failed to open the device", err);
      this.device = undefined;
    }
  }
  async selectApplet() {
    let r = await this.transceive("00A4040007A0000005272101");
    if (!r.endsWith("9000")) throw new Error("Failed to select OATH applet");
  }
  async executeCommand(ins: number, payload: Uint8Array = new Uint8Array(0)) {
    console.debug('executeCommand', ins, payload);
    await this.selectApplet();
    let capdu = Uint8Array.from([
      0,
      ins,
      0,
      0,
      payload.length,
      ...Array.from(payload)
    ]);
    let rapdu = await this.transceive(Canokey.byteToHexString(capdu));
    let ret = rapdu.slice(0, -4);
    while (rapdu.slice(-4, -2) == "61") {
      rapdu = await this.transceive("00060000");
      ret += rapdu.slice(0, -4);
    }
    if (!rapdu.endsWith("9000"))
      throw new Error("Command failed with " + rapdu.slice(-4));
    return Canokey.hexStringToByte(ret);
  }
  static async processTlv(
    tlv: Uint8Array,
    callback: (tag: number, data: Uint8Array) => Promise<void>
  ) {
    for (let i = 0; i < tlv.length;) {
      const tag = tlv[i++];
      const len = tlv[i++];
      await callback(tag, tlv.slice(i, i + len));
      i += len;
    }
  }
  async listEntries() {
    let entries: {
      type: OTPType;
      algo: OTPAlgorithm;
      name: string;
    }[] = [];
    try {
      let tlv = await this.executeCommand(0x03);
      await Canokey.processTlv(tlv, async (tag, data) => {
        if (tag != 0x72) {
          console.warn(`Unknown tag ${tag}`);
        } else {
          // const prop = data[0];
          // entries.push({
          //   type: (prop & 0xf0) == 0x10 ? OTPType.hotp : OTPType.totp,
          //   algo:
          //     (prop & 0x0f) == 0x01 ? OTPAlgorithm.SHA1 : OTPAlgorithm.SHA256,
          //   name: this.utf8Decoder.decode(data.slice(1))
          // });
          entries.push({
            type: OTPType.totp,
            algo: OTPAlgorithm.SHA1,
            name: this.utf8Decoder.decode(data)
          });
        }
      });
    } catch (err) {
      console.error("listEntries failed", err);
    }
    return entries;
  }
  static uint64ToBytes(val: number) {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(0, val >>> 32, false);
    view.setUint32(4, val & 0xffffffff, false);
    return new Uint8Array(buffer);
  }
  async calculateAll(challenge: number) {
    let entries: {
      name: string;
      digits: number;
      code: number | SpecialCode;
    }[] = [];
    try {
      const chalBytes = Canokey.uint64ToBytes(challenge);
      let tlv = await this.executeCommand(
        0x05,
        Uint8Array.from([0x74, chalBytes.length, ...Array.from(chalBytes)])
      );
      let tag_count = 0;
      let name: string;
      let digits: number;
      let code: number | SpecialCode;
      await Canokey.processTlv(tlv, async (tag, data) => {
        if (tag == 0x77) {
          digits = 0;
          code = SpecialCode.hotpNoResponse;
        } else if (tag == 0x7c) {
          digits = 0;
          code = SpecialCode.touchRequired;
        } else if (tag == 0x76) {
          digits = data[0];
          code = new DataView(data.buffer, 1).getUint32(0, false);
        } else if (tag == 0x71) {
          name = this.utf8Decoder.decode(data);
        } else {
          console.warn(`Unknown tag ${tag}`);
          return;
        }
        if (++tag_count % 2 == 0) {
          entries.push({
            name: name,
            code: code,
            digits: digits
          });
        }
      });
    } catch (err) {
      console.error("calculateAll failed", err);
    }
    return entries;
  }
  async calculateOne(name: string, challenge: number = 0) {
    try {
      const chalBytes = Canokey.uint64ToBytes(challenge);
      const nameBytes = this.utf8Encoder.encode(name);
      let tlv = await this.executeCommand(
        0x04,
        Uint8Array.from([
          0x71,
          nameBytes.length,
          ...Array.from(nameBytes),
          0x74,
          chalBytes.length,
          ...Array.from(chalBytes)
        ])
      );
      let digits = 0;
      let code = 0;
      await Canokey.processTlv(tlv, async (tag, data) => {
        if (tag == 0x76) {
          digits = data[0];
          code = new DataView(data.buffer, 1).getUint32(0, false);
        } else {
          console.warn(`Unknown tag ${tag}`);
        }
      });
      return { digits: digits, code: code };
    } catch (err) {
      console.error("calculateOne failed", err);
    }
    return null;
  }
  async putNewEntry(name: string, secret: string, algo: OTPAlgorithm, type: OTPType, digits: number) {
    try {
      const secBytes = Canokey.hexStringToByte(Canokey.base32ToHex(secret));
      const nameBytes = this.utf8Encoder.encode(name);
      await this.executeCommand(
        0x01,
        Uint8Array.from([
          0x71,
          nameBytes.length,
          ...Array.from(nameBytes),
          0x73,
          secBytes.length + 2,
          (algo == OTPAlgorithm.SHA1 ? 1 : 2) | (type == OTPType.hotp ? 0x10 : 0x20),
          digits & 0xf,
          ...Array.from(secBytes),
          0x78, 1, 0,
        ])
      );
      return true;
    } catch (err) {
      console.error("putNewEntry failed", err);
    }
    return false;
  }
  async deleteEntry(name: string) {
    try {
      const nameBytes = this.utf8Encoder.encode(name);
      await this.executeCommand(
        0x02,
        Uint8Array.from([
          0x71,
          nameBytes.length,
          ...Array.from(nameBytes),
        ])
      );
      return true;
    } catch (err) {
      console.error("deleteEntry failed", err);
    }
    return false;
  }
}

export class HWTokenManager {
  static tokenDevice = new Canokey();
  static totpCache: Record<number, Record<string, string>> = {};
  static entryCache: HWTokenEntry[] | undefined;
  static async connect() {
    if (!HWTokenManager.tokenDevice.isConnected())
      await HWTokenManager.tokenDevice.connectToDevice();
  }
  static connected() {
    return HWTokenManager.tokenDevice.isConnected();
  }
  static async add(entry: OTPEntry) {
    if (!entry.secret) return
    if (await HWTokenManager.tokenDevice.putNewEntry(entry.issuer, entry.secret, entry.algorithm, entry.type, entry.digits))
      HWTokenManager.entryCache = undefined;
  }
  static async delete(entry: HWTokenEntry) {
    if (await HWTokenManager.tokenDevice.deleteEntry(entry.issuer))
      HWTokenManager.entryCache = undefined;
  }
  static async get() {
    console.log("HWTokenManager.get")
    if (HWTokenManager.entryCache !== undefined)
      return HWTokenManager.entryCache;
    const hwEntries = await HWTokenManager.tokenDevice.listEntries();
    let index = 1;
    return HWTokenManager.entryCache = hwEntries.map(item => {
      return new HWTokenEntry({
        index: index++,
        type: item.type,
        issuer: item.name,
        algorithm: item.algo
      });
    });
  }
  static async getCalculated() {
    let entries = await HWTokenManager.get();
    console.log('entries', entries);
    for (const account of entries)
        await account.generate();
    return entries;
  }
  private static num2str(val: number, digits: number) {
    let s = ("" + val);
    if (s.length >= digits)
      return s.substring(s.length - digits);
    return "0".repeat(digits - s.length) + s;
  }
  private static async calcThenCache(challenge: number, entry: OTPEntry) {
    console.log("calcThenCache")
    const results = await HWTokenManager.tokenDevice.calculateAll(challenge);
    let cache: Record<string, string> = {};
    if (results) {
      results.forEach(item => {
        if (item.code >= 0)
          cache[item.name] = HWTokenManager.num2str(item.code, item.digits);
      });
      HWTokenManager.totpCache[challenge] = cache;
    }
    console.log("cache=",cache,entry.issuer,cache[entry.issuer])
    return entry.issuer in cache ? cache[entry.issuer] : null;
  }
  static async calc(entry: OTPEntry) {
    if (entry.type !== OTPType.hotp) {
      let epoch = Math.round(new Date().getTime() / 1000.0);
      if (localStorage.offset) {
        epoch = epoch + Number(localStorage.offset);
      }
      let chal = Math.floor(epoch / entry.period);
      if (chal in HWTokenManager.totpCache) {
        const cache = HWTokenManager.totpCache[chal];
        if (entry.issuer in cache) return cache[entry.issuer];
      }
      return await HWTokenManager.calcThenCache(chal, entry);
    } else {
      const result = await HWTokenManager.tokenDevice.calculateOne(
        entry.issuer,
        0
      );
      return result === null
        ? null
        : HWTokenManager.num2str(result.code, result.digits);
    }
  }
}

export class HWTokenEntry extends OTPEntry {
  constructor(entry: {
    account?: string;
    index: number;
    issuer?: string;
    type: OTPType;
    period?: number;
    hash?: string;
    digits?: number;
    algorithm?: OTPAlgorithm;
  }) {
    super({
      account: entry.account,
      index: entry.index,
      issuer: entry.issuer,
      type: entry.type,
      period: entry.period,
      hash: entry.hash,
      digits: entry.digits,
      algorithm: entry.algorithm,
      secret: '',
      counter: 0
    });
    // this.secret = null;
  }
  // async create() {
  //   await HWTokenManager.add(this);
  // }
  // async delete() {
  //   await HWTokenManager.delete(this);
  // }
  async generate() {
    const code = await HWTokenManager.calc(this);
    this.code = code ? code : "&bull;&bull;&bull;&bull;&bull;&bull;";
  }
}
