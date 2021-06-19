import { DriverDFU } from "./dfu.driver";
import { dfuCommands, WebDFUDriver } from "./base.driver";
import { WebDFULog, WebDFUSettings } from "./types";
import { parseDfuSeMemoryDescriptor, WebDFUError } from "./core";

export type DFUseMemorySegment = {
  start: number;
  end: number;
  sectorSize: number;

  readable: boolean;
  erasable: boolean;
  writable: boolean;
};

export enum DFUseCommands {
  GET_COMMANDS = 0x00,
  SET_ADDRESS = 0x21,
  ERASE_SECTOR = 0x41,
}

export class DriverDFUse extends WebDFUDriver {
  startAddress: number = NaN;
  memoryInfo?: { name: string; segments: DFUseMemorySegment[] };

  constructor(device: USBDevice, settings: WebDFUSettings, log?: WebDFULog) {
    super(device, settings, log);

    if (this.settings.name) {
      this.memoryInfo = parseDfuSeMemoryDescriptor(this.settings.name);
    }
  }

  getSegment(addr: number): DFUseMemorySegment | null {
    if (!this.memoryInfo || !this.memoryInfo.segments) {
      throw new WebDFUError("No memory map information available");
    }

    for (let segment of this.memoryInfo.segments) {
      if (segment.start <= addr && addr < segment.end) {
        return segment;
      }
    }

    return null;
  }

  getSectorStart(addr: number, segment: DFUseMemorySegment | null) {
    if (typeof segment === "undefined") {
      segment = this.getSegment(addr);
    }

    if (!segment) {
      throw new WebDFUError(`Address ${addr.toString(16)} outside of memory map`);
    }

    const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
    return segment.start + sectorIndex * segment.sectorSize;
  }

  getSectorEnd(addr: number, segment = this.getSegment(addr)) {
    if (!segment) {
      throw new WebDFUError(`Address ${addr.toString(16)} outside of memory map`);
    }

    const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
    return segment.start + (sectorIndex + 1) * segment.sectorSize;
  }

  getFirstWritableSegment() {
    if (!this.memoryInfo || !this.memoryInfo.segments) {
      throw new WebDFUError("No memory map information available");
    }

    for (let segment of this.memoryInfo.segments) {
      if (segment.writable) {
        return segment;
      }
    }

    return null;
  }

  getMaxReadSize(startAddr: number) {
    if (!this.memoryInfo || !this.memoryInfo.segments) {
      throw new WebDFUError("No memory map information available");
    }

    let numBytes = 0;
    for (let segment of this.memoryInfo.segments) {
      if (segment.start <= startAddr && startAddr < segment.end) {
        // Found the first segment the read starts in
        if (segment.readable) {
          numBytes += segment.end - startAddr;
        } else {
          return 0;
        }
      } else if (segment.start === startAddr + numBytes) {
        // Include a contiguous segment
        if (segment.readable) {
          numBytes += segment.end - segment.start;
        } else {
          break;
        }
      }
    }

    return numBytes;
  }

  protected async erase(startAddr: number, length: number) {
    let segment = this.getSegment(startAddr);
    let addr = this.getSectorStart(startAddr, segment);
    const endAddr = this.getSectorEnd(startAddr + length - 1);

    if (!segment) {
      throw new WebDFUError("Unknown segment");
    }

    let bytesErased = 0;
    const bytesToErase = endAddr - addr;
    if (bytesToErase > 0) {
      this.logProgress(bytesErased, bytesToErase);
    }

    while (addr < endAddr) {
      if ((segment?.end ?? 0) <= addr) {
        segment = this.getSegment(addr);
      }

      if (!segment?.erasable) {
        // Skip over the non-erasable section
        bytesErased = Math.min(bytesErased + (segment?.end ?? 0) - addr, bytesToErase);
        addr = segment?.end ?? 0;
        this.logProgress(bytesErased, bytesToErase);
        continue;
      }

      const sectorIndex = Math.floor((addr - segment.start) / segment.sectorSize);
      const sectorAddr = segment.start + sectorIndex * segment.sectorSize;
      await this.dfuseCommand(DFUseCommands.ERASE_SECTOR, sectorAddr, 4);
      addr = sectorAddr + segment.sectorSize;
      bytesErased += segment.sectorSize;
      this.logProgress(bytesErased, bytesToErase);
    }
  }

  async do_write(xfer_size: number, data: ArrayBuffer) {
    if (!this.memoryInfo || !this.memoryInfo.segments) {
      throw new WebDFUError("No memory map available");
    }

    this.logInfo("Erasing DFU device memory");

    let bytes_sent = 0;
    let expected_size = data.byteLength;

    let startAddress: number | undefined = this.startAddress;
    if (isNaN(startAddress)) {
      startAddress = this.memoryInfo.segments[0]?.start;
      if (!startAddress) {
        throw new WebDFUError("startAddress not found");
      }
      this.logWarning("Using inferred start address 0x" + startAddress.toString(16));
    } else if (this.getSegment(startAddress) === null) {
      this.logError(`Start address 0x${startAddress.toString(16)} outside of memory map bounds`);
    }
    await this.erase(startAddress, expected_size);

    this.logInfo("Copying data from browser to DFU device");

    let address = startAddress;
    while (bytes_sent < expected_size) {
      const bytes_left = expected_size - bytes_sent;
      const chunk_size = Math.min(bytes_left, xfer_size);

      let bytes_written = 0;
      let dfu_status;
      try {
        await this.dfuseCommand(DFUseCommands.SET_ADDRESS, address, 4);
        bytes_written = await this.write(data.slice(bytes_sent, bytes_sent + chunk_size), 2);
        dfu_status = await this.poll_until_idle(dfuCommands.dfuDNLOAD_IDLE);
        address += chunk_size;
      } catch (error) {
        throw new WebDFUError("Error during DfuSe write: " + error);
      }

      if (dfu_status.status != dfuCommands.STATUS_OK) {
        throw new WebDFUError(`DFU WRITE failed state=${dfu_status.state}, status=${dfu_status.status}`);
      }

      bytes_sent += bytes_written;

      this.logProgress(bytes_sent, expected_size);
    }
    this.logInfo(`Wrote ${bytes_sent} bytes`);

    this.logInfo("Manifesting new firmware");
    try {
      await this.dfuseCommand(DFUseCommands.SET_ADDRESS, startAddress, 4);
      await this.write(new ArrayBuffer(0), 0);
    } catch (error) {
      throw new WebDFUError("Error during DfuSe manifestation: " + error);
    }

    try {
      await this.poll_until((state) => state === dfuCommands.dfuMANIFEST);
    } catch (error) {
      this.logError(error);
    }
  }

  async do_read(xfer_size: number, max_size = Infinity) {
    if (!this.memoryInfo) {
      throw new WebDFUError("Unknown a DfuSe memory info");
    }

    let startAddress: number | undefined = this.startAddress;
    if (isNaN(startAddress)) {
      startAddress = this.memoryInfo.segments[0]?.start;
      if (!startAddress) {
        throw new WebDFUError("Unknown memory segments");
      }
      this.logWarning("Using inferred start address 0x" + startAddress.toString(16));
    } else if (!this.getSegment(startAddress)) {
      this.logWarning(`Start address 0x${startAddress.toString(16)} outside of memory map bounds`);
    }

    this.logInfo(`Reading up to 0x${max_size.toString(16)} bytes starting at 0x${startAddress.toString(16)}`);
    let state = await this.getState();
    if (state != dfuCommands.dfuIDLE) {
      await this.abortToIdle();
    }
    await this.dfuseCommand(DFUseCommands.SET_ADDRESS, startAddress, 4);
    await this.abortToIdle();

    // DfuSe encodes the read address based on the transfer size,
    // the block number - 2, and the SET_ADDRESS pointer.
    return await DriverDFU.prototype.do_read.call(this, xfer_size, max_size, 2);
  }

  // Private methods
  private async dfuseCommand(command: number, param = 0x00, len = 1) {
    const commandNames: Record<number, string> = {
      [DFUseCommands.GET_COMMANDS]: "GET_COMMANDS",
      [DFUseCommands.SET_ADDRESS]: "SET_ADDRESS",
      [DFUseCommands.ERASE_SECTOR]: "ERASE_SECTOR",
    };

    let payload = new ArrayBuffer(len + 1);
    let view = new DataView(payload);
    view.setUint8(0, command);
    if (len === 1) {
      view.setUint8(1, param);
    } else if (len === 4) {
      view.setUint32(1, param, true);
    } else {
      throw new WebDFUError("Don't know how to handle data of len " + len);
    }

    try {
      await this.write(payload, 0);
    } catch (error) {
      throw new WebDFUError("Error during special DfuSe command " + commandNames[command] + ":" + error);
    }

    let status = await this.poll_until((state) => state != dfuCommands.dfuDNBUSY);

    if (status.status != dfuCommands.STATUS_OK) {
      throw new WebDFUError("Special DfuSe command " + command + " failed");
    }
  }
}
