import type { BridgeApi } from "../../net/bridge-api.ts";
import type { ConnectionManager } from "../../net/connection.ts";
import type { PairInput } from "../../net/pair-link.ts";
import type { ConnectionState } from "../../store/core.ts";
import type { machinesStore } from "../../store/platform.ts";
import type { Secrets } from "../../store/secrets.ts";
import { consumeCapturedPairFragment } from "./pair-fragment.ts";
import {
  type PairedDevice,
  pairAndStore,
  pairingCanRetry,
  pairingErrorMessage,
  parsePairingInput,
} from "./pairing.ts";

export interface PairingViewState {
  manual: boolean;
  scannerVisible: boolean;
  address: string;
  code: string;
  busy: boolean;
  banner?: string;
  retryable: boolean;
  paired?: PairedDevice;
  connectionState?: ConnectionState;
}

export class PairingController {
  private state: PairingViewState = {
    manual: false,
    scannerVisible: false,
    address: "",
    code: "",
    busy: false,
    retryable: false,
  };
  private readonly listeners = new Set<() => void>();
  private retryInput: PairInput | undefined;
  private connectionManager: ConnectionManager | undefined;
  private connectionGeneration = 0;
  private unsubscribeConnection = () => {};
  private readonly api: BridgeApi;
  private readonly secrets: Secrets;
  private readonly machines: typeof machinesStore;
  private readonly deviceName: string;

  constructor(
    api: BridgeApi,
    secrets: Secrets,
    machines: typeof machinesStore,
    deviceName: string,
  ) {
    this.api = api;
    this.secrets = secrets;
    this.machines = machines;
    this.deviceName = deviceName;
  }

  getSnapshot = (): PairingViewState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setConnectionManager(manager: ConnectionManager | undefined): void {
    if (this.connectionManager === manager) return;
    const generation = ++this.connectionGeneration;
    this.unsubscribeConnection();
    this.connectionManager = manager;
    this.update({ connectionState: manager?.state() });
    this.unsubscribeConnection =
      manager?.subscribe((connectionState) => {
        if (generation === this.connectionGeneration) this.update({ connectionState });
      }) ?? (() => {});
  }

  consumeCapturedPairFragment(): void {
    const input = consumeCapturedPairFragment();
    if (input) void this.pair(input);
  }

  setAddress = (address: string): void => this.update({ address });

  setCode = (code: string): void => this.update({ code });

  showManualEntry = (): void => this.update({ manual: true });

  hideManualEntry = (): void => this.update({ manual: false });

  showScanner = (): void => this.update({ scannerVisible: true });

  closeScanner = (): void => this.update({ scannerVisible: false });

  submitManual = (): void => {
    const input = parsePairingInput(this.state.address, this.state.code);
    if (!input) {
      this.retryInput = undefined;
      this.update({
        banner: "Enter a valid bridge URL and its 8-character pairing code.",
        retryable: false,
      });
      return;
    }
    void this.pair(input);
  };

  acceptScan = (input: PairInput): void => {
    this.update({ scannerVisible: false });
    void this.pair(input);
  };

  retry = (): void => {
    if (this.state.retryable && this.retryInput) void this.pair(this.retryInput);
  };

  pairAnotherMachine = (): void => this.update({ paired: undefined, banner: undefined });

  private async pair(input: PairInput): Promise<void> {
    if (this.state.busy) return;
    this.retryInput = input;
    this.unsubscribeConnection();
    this.unsubscribeConnection = () => {};
    this.update({
      address: input.url,
      code: input.code,
      banner: undefined,
      retryable: false,
      busy: true,
      connectionState: undefined,
    });
    try {
      const paired = await pairAndStore(
        input,
        this.api,
        this.secrets,
        this.machines,
        this.deviceName,
      );
      this.update({ paired, code: "", manual: false });
    } catch (error) {
      this.update({ banner: pairingErrorMessage(error), retryable: pairingCanRetry(error) });
    } finally {
      this.update({ busy: false });
    }
  }

  private update(patch: Partial<PairingViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
