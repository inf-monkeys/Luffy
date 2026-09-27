import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isProfileFile } from "./profile_schema.mjs";

// Walk the profile tree without following directory symlinks. Keeping the
// relative path with each file lets callers report useful validation errors
// while still using the profile's schema id as its public identifier.
export async function findProfileFiles(profilesDirectory) {
  const directories = [{ absolutePath: profilesDirectory, relativePath: "" }];
  const files = [];

  while (directories.length > 0) {
    const directory = directories.pop();
    const entries = (await readdir(directory.absolutePath, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const relativePath = join(directory.relativePath, entry.name);
      const absolutePath = join(directory.absolutePath, entry.name);
      if (entry.isDirectory()) {
        directories.push({ absolutePath, relativePath });
      } else if ((entry.isFile() || entry.isSymbolicLink()) && isProfileFile(entry.name)) {
        files.push({ absolutePath, relativePath });
      }
    }
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
