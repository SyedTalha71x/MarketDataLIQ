export class FIXMessageBuilder {
  private senderCompID: string;
  private targetCompID: string;
  private sequenceNumber: number;

  constructor(senderCompID: string, targetCompID: string) {
    this.senderCompID = senderCompID;
    this.targetCompID = targetCompID;
    this.sequenceNumber = 1;
  }

  private getUTCTimestamp(): string {
    return new Date()
      .toISOString()
      .replace(/[-:.TZ]/g, "")
      .slice(0, 17);
  }

  private buildHeader(msgType: string): string {
    return (
      `8=FIX.4.4\u0001` +
      `9=000\u0001` +
      `35=${msgType}\u0001` +
      `49=${this.senderCompID}\u0001` +
      `56=${this.targetCompID}\u0001` +
      `34=${this.sequenceNumber++}\u0001` +
      `52=${this.getUTCTimestamp()}\u0001`
    );
  }

  private calculateChecksum(message: string): string {
    const sum = message
      .split("")
      .reduce((acc, char) => acc + char.charCodeAt(0), 0);
    return (sum % 256).toString().padStart(3, "0");
  }

  private buildTrailer(message: string): string {
    const checksum = this.calculateChecksum(message);
    return `${message}10=${checksum}\u0001`;
  }

  public heartbeat(testReqID?: string): string {
    const header = this.buildHeader("0");
    const body = testReqID ? `112=${testReqID}\u0001` : "";
    return this.buildTrailer(header + body);
  }

  public testRequest(testReqID: string): string {
    const header = this.buildHeader("1");
    const body = `112=${testReqID}\u0001`;
    return this.buildTrailer(header + body);
  }

  public logon(
    username: string,
    password: string,
    heartbeatInterval: number = 30
  ): string {
    const header = this.buildHeader("A");
    const body =
      `98=0\u0001` +
      `108=${heartbeatInterval}\u0001` +
      `553=${username}\u0001` +
      `554=${password}\u0001` +
      `141=Y\u0001`;
    return this.buildTrailer(header + body);
  }

  public logout(text?: string): string {
    const header = this.buildHeader("5");
    const body = text ? `58=${text}\u0001` : "";
    return this.buildTrailer(header + body);
  }

  public resendRequest(beginSeqNo: number, endSeqNo: number = 0): string {
    const header = this.buildHeader("2");
    const body = `7=${beginSeqNo}\u0001` + `16=${endSeqNo}\u0001`;
    return this.buildTrailer(header + body);
  }

  public reject(refSeqNo: number, text?: string): string {
    const header = this.buildHeader("3");
    const body = `45=${refSeqNo}\u0001` + (text ? `58=${text}\u0001` : "");
    return this.buildTrailer(header + body);
  }

  public businessReject(
    refSeqNo: number,
    refMsgType: string,
    reason: number,
    text?: string
  ): string {
    const header = this.buildHeader("j");
    const body =
      `45=${refSeqNo}\u0001` +
      `372=${refMsgType}\u0001` +
      `373=${reason}\u0001` +
      (text ? `58=${text}\u0001` : "");
    return this.buildTrailer(header + body);
  }

  public sequenceReset(newSeqNo: number, gapFillFlag: boolean = false): string {
    const header = this.buildHeader("4");
    const body =
      `36=${newSeqNo}\u0001` + `123=${gapFillFlag ? "Y" : "N"}\u0001`;
    return this.buildTrailer(header + body);
  }
}
