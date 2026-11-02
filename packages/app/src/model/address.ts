export interface AddressParts {
  /** Remote machine prefix, absent for a terminal on the current core. */
  machine: string | undefined;
  /** Terminal name without the optional remote machine prefix. */
  terminal: string;
}

/** Split `machine/terminal` addresses while leaving local `t7` addresses intact. */
export function splitAddress(address: string): AddressParts {
  const slash = address.indexOf("/");
  if (slash <= 0 || slash === address.length - 1) return { machine: undefined, terminal: address };
  return { machine: address.slice(0, slash), terminal: address.slice(slash + 1) };
}

export function machinePrefix(address: string): string | undefined {
  return splitAddress(address).machine;
}
