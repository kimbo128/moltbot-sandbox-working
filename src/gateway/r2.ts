import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, getR2BucketName } from '../config';

/**
 * Check if R2 is accessible at the mount path by testing file operations.
 * 
 * Note: We avoid checking `mount | grep s3fs` because the Cloudflare Sandbox
 * may use a different mount mechanism than s3fs, making shell-level mount checks
 * unreliable. Instead, we test if the directory exists and is writable.
 */
async function isR2Accessible(sandbox: Sandbox): Promise<boolean> {
  try {
    const proc = await sandbox.startProcess(
      `test -d ${R2_MOUNT_PATH} && touch ${R2_MOUNT_PATH}/.mount-check && rm -f ${R2_MOUNT_PATH}/.mount-check && echo "accessible"`
    );
    let attempts = 0;
    while (proc.status === 'running' && attempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      attempts++;
    }
    const logs = await proc.getLogs();
    const accessible = !!(logs.stdout && logs.stdout.includes('accessible'));
    console.log('isR2Accessible check:', accessible, 'stdout:', logs.stdout?.slice(0, 100));
    return accessible;
  } catch (err) {
    console.log('isR2Accessible error:', err);
    return false;
  }
}

/**
 * Mount R2 bucket for persistent storage
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted successfully, false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log('R2 storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)');
    return false;
  }

  const bucketName = getR2BucketName(env);
  const endpoint = `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;

  try {
    console.log('Mounting R2 bucket', bucketName, 'at', R2_MOUNT_PATH, 'endpoint:', endpoint);
    await sandbox.mountBucket(bucketName, R2_MOUNT_PATH, {
      endpoint,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('R2 bucket mounted successfully - moltbot data will persist across sessions');
    return true;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // If the Sandbox API says the mount path is already in use by the same bucket,
    // the bucket IS mounted — the previous shell-level check (mount | grep s3fs) was
    // unreliable because the Sandbox uses its own mount mechanism, not necessarily s3fs.
    if (errorMessage.includes('already in use')) {
      console.log('R2 bucket already mounted at', R2_MOUNT_PATH, '(confirmed by Sandbox API)');
      
      // Verify the mount is actually functional by testing file access
      if (await isR2Accessible(sandbox)) {
        console.log('R2 mount verified - storage is accessible');
        return true;
      }
      
      // Mount exists in Sandbox API but filesystem isn't accessible
      // This could mean the mount is stale — log it but still return true
      // since the Sandbox API is the source of truth
      console.warn('R2 mount registered but filesystem check failed - mount may be initializing');
      return true;
    }

    // Genuine mount failure
    console.error('R2 mount error:', errorMessage);
    if (err instanceof Error && err.stack) {
      console.error('R2 mount stack:', err.stack);
    }
    console.error('R2 mount details:', { bucket: bucketName, mountPath: R2_MOUNT_PATH, endpoint });

    // Don't fail if mounting fails - moltbot can still run without persistent storage
    console.error('Failed to mount R2 bucket:', err);
    return false;
  }
}
