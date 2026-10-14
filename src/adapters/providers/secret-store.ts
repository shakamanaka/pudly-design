import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Backend-only credential storage. Callers must never serialize returned values. */
export interface SecretStore {
  put(secret: string, previousRef?: string): Promise<string>;
  get(reference: string): Promise<string>;
  delete(reference: string): Promise<void>;
}

/** Plaintext local fallback with owner-only directory/file permissions and atomic replacement; this is not encryption or an OS keychain. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly directory: string) {}

  async put(secret: string, previousRef?: string): Promise<string> {
    if (typeof secret !== 'string' || secret.length === 0 || Buffer.byteLength(secret) > 16_384) throw new Error('Credential is empty or exceeds its size limit.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const reference = previousRef ?? randomUUID();
    if (!/^[0-9a-f-]{36}$/i.test(reference)) throw new Error('Invalid secret reference.');
    const target = join(this.directory, `${reference}.secret`);
    const temporary = join(this.directory, `.${reference}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, secret, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      await chmod(target, 0o600);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return reference;
  }

  async get(reference: string): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(reference)) throw new Error('Invalid secret reference.');
    const value = await readFile(join(this.directory, `${reference}.secret`), 'utf8');
    if (!value || Buffer.byteLength(value) > 16_384) throw new Error('Stored credential is invalid.');
    return value;
  }

  async delete(reference: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(reference)) throw new Error('Invalid secret reference.');
    await rm(join(this.directory, `${reference}.secret`), { force: true });
  }
}
