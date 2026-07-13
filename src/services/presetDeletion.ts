interface DeletableEntry {
  delete: () => Promise<void>;
}

interface EntryFolder {
  getEntry: (fileName: string) => Promise<DeletableEntry>;
}

const isMissingEntryError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code.toLowerCase() : "";
  const name = typeof candidate.name === "string" ? candidate.name.toLowerCase() : "";
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return (
    code === "enoent" ||
    code === "notfound" ||
    code === "not_found" ||
    name === "notfounderror" ||
    name === "entrynotfounderror" ||
    /\b(not found|does not exist|could not find)\b/.test(message)
  );
};

const deleteIfPresent = async (folder: EntryFolder, fileName: string): Promise<void> => {
  let entry: DeletableEntry;
  try {
    entry = await folder.getEntry(fileName);
  } catch (error) {
    if (isMissingEntryError(error)) {
      return;
    }
    throw error;
  }
  try {
    await entry.delete();
  } catch (error) {
    if (!isMissingEntryError(error)) {
      throw error;
    }
  }
};

export const deletePresetEntries = async (folder: EntryFolder, fileName: string): Promise<void> => {
  await deleteIfPresent(folder, `${fileName}.bak`);
  await deleteIfPresent(folder, fileName);
};
