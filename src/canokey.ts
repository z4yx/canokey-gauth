import { OTPType, OTPAlgorithm, OTPEntry } from "./otp";

export enum SpecialCode {
  hotpNoResponse = -2,
  touchRequired = -1
}

export class Canokey {
  device: USBDevice | undefined;
  utf8Decoder = new TextDecoder("utf-8");
  utf8Encoder = new TextEncoder();

  isConnected() {
    return this.device instanceof USBDevice && this.device.opened;
  }

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

  static reshape(data: Uint8Array) {
    const packets = [];
    for (let i = 0; i < data.length; i += 16)
      packets.push(data.slice(i, i + 16));
    return packets;
  }

  static async sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async transceive(capdu: String) {
    if (!this.device) throw new Error("Device not connected");
    console.log("Tx", capdu);
    let data = Canokey.hexStringToByte(capdu);
    let reshapedData = Canokey.reshape(data); // divide command into 16-byte chunks
    // send a command
    console.log('to s', this.device, reshapedData);
    for (let i = 0; i < reshapedData.length; ++i)
      await this.device.controlTransferOut(
        {
          requestType: "vendor",
          recipient: "interface",
          request: 0,
          value: (i == 0 ? 0x4000 : 0x8000) + i,
          index: 1
        },
        reshapedData[i]
      );
    console.log('sent');
    // execute
    let resp = await this.device.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "interface",
        request: 1,
        value: 0,
        index: 1
      },
      0
    );
    console.log('exec');
    // wait for execution
    for (let retry = 0; ; retry++) {
      resp = await this.device.controlTransferIn(
        {
          requestType: "vendor",
          recipient: "interface",
          request: 3,
          value: 0,
          index: 1
        },
        1
      );
      if (!resp.data) throw new Error("Empty data from the device");
      console.log('wait', resp.data.byteLength, resp.data.getUint8(0));
      if (resp.data.getUint8(0) == 0) break;
      if (retry >= 5) throw new Error("Device timeout");
      await Canokey.sleep(100);
    }
    // get the response
    resp = await this.device.controlTransferIn(
      {
        requestType: "vendor",
        recipient: "interface",
        request: 2,
        value: 0,
        index: 1
      },
      1500
    );
    if (resp.status === "ok") {
      if (!resp.data) throw new Error("Empty data from the device");
      let rx = Canokey.byteToHexString(new Uint8Array(resp.data.buffer));
      console.log("rx    ", rx);
      return rx;
    }
    return "";
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
        console.log(this.device);
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
      if(this.device.configuration === null)
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
    console.log('executeCommand', ins, payload);
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
    for (let i = 0; i < tlv.length; ) {
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
          const prop = data[0];
          entries.push({
            type: (prop & 0xf0) == 0x10 ? OTPType.hotp : OTPType.totp,
            algo:
              (prop & 0x0f) == 0x01 ? OTPAlgorithm.SHA1 : OTPAlgorithm.SHA256,
            name: this.utf8Decoder.decode(data.slice(1))
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
          code = new DataView(data, 1).getUint32(0, false);
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
          code = new DataView(data, 1).getUint32(0, false);
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
    HWTokenManager.entryCache = undefined;
  }
  static async delete(entry: HWTokenEntry) {
    HWTokenManager.entryCache = undefined;
  }
  static async get() {
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
  private static num2str(val: number, digits: number) {
    let s = ("" + val);
    return "0".repeat(digits - s.length) + s;
  }
  private static async calcThenCache(challenge: number, entry: OTPEntry) {
    const results = await HWTokenManager.tokenDevice.calculateAll(challenge);
    let cache: Record<string, string> = {};
    if (results) {
      results.forEach(item => {
        if (item.code >= 0)
          cache[item.name] = HWTokenManager.num2str(item.code, item.digits);
      });
      HWTokenManager.totpCache[challenge] = cache;
    }
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
  async create() {
    await HWTokenManager.add(this);
  }
  async delete() {
    await HWTokenManager.delete(this);
  }
  async generate() {
    const code = await HWTokenManager.calc(this);
    this.code = code ? code : "&bull;&bull;&bull;&bull;&bull;&bull;";
  }
}
