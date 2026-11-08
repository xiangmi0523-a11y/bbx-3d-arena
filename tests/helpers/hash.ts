/** 小型确定性指纹（FNV-1a 64 位，字符串输入），用于比较物理轨迹是否逐步相同 */
export class Fingerprint {
  private h = 0xcbf29ce484222325n;
  update(s: string): this {
    for (let i = 0; i < s.length; i++) {
      this.h ^= BigInt(s.charCodeAt(i));
      this.h = (this.h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return this;
  }
  digest(): string {
    return this.h.toString(16).padStart(16, '0');
  }
}
