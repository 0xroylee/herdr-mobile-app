export function shortenHomeFolder(folder: string, homeDirectory?: string): string {
  if (!homeDirectory) return folder;

  const normalizedHome = homeDirectory.replace(/\/+$/u, "") || "/";
  if (folder === normalizedHome) return "~";

  const homePrefix = normalizedHome === "/" ? "/" : `${normalizedHome}/`;
  if (!folder.startsWith(homePrefix)) return folder;

  return `~/${folder.slice(homePrefix.length)}`;
}
