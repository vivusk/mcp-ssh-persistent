/**
 * SSH SFTP Operations
 * Handles file transfers via SFTP protocol
 */
import { createReadStream, createWriteStream } from 'fs';
import { stat } from 'fs/promises';
import { basename } from 'path';

/**
 * Manage SFTP file operations
 */
export class SSHSFTP {
  /**
   * @param {Function} getClient - Function to get SSH2 client
   * @param {Function} isConnected - Function to check connection status
   */
  constructor(getClient, isConnected) {
    this._getClient = getClient;
    this._isConnected = isConnected;
  }

  /**
   * Get SFTP session from client
   * @returns {Promise<object>} SFTP session
   */
  _getSFTP() {
    return new Promise((resolve, reject) => {
      const client = this._getClient();
      client.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }

  /**
   * Upload file from local to remote
   * @param {string} localPath - Local file path
   * @param {string} remotePath - Remote destination (file or directory/)
   * @returns {Promise<object>} Upload result
   */
  async upload(localPath, remotePath) {
    if (!this._isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    const localStats = await stat(localPath);
    if (!localStats.isFile()) {
      throw new Error('Local path must be a file');
    }

    const sftp = await this._getSFTP();

    // Append filename if remotePath is directory
    const finalRemotePath = remotePath.endsWith('/')
      ? remotePath + basename(localPath)
      : remotePath;

    return new Promise((resolve, reject) => {
      const readStream = createReadStream(localPath);
      const writeStream = sftp.createWriteStream(finalRemotePath);

      writeStream.on('close', () => {
        sftp.end();
        resolve({
          success: true,
          localPath,
          remotePath: finalRemotePath,
          size: localStats.size
        });
      });

      writeStream.on('error', (err) => {
        sftp.end();
        reject(err);
      });

      readStream.pipe(writeStream);
    });
  }

  /**
   * Download file from remote to local
   * @param {string} remotePath - Remote file path
   * @param {string} localPath - Local destination (file or directory/\)
   * @returns {Promise<object>} Download result
   */
  async download(remotePath, localPath) {
    if (!this._isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    const sftp = await this._getSFTP();

    return new Promise((resolve, reject) => {
      // Get remote file stats
      sftp.stat(remotePath, (statErr, stats) => {
        if (statErr) {
          sftp.end();
          reject(statErr);
          return;
        }

        // Append filename if localPath is directory
        const finalLocalPath = (localPath.endsWith('/') || localPath.endsWith('\\'))
          ? localPath + basename(remotePath)
          : localPath;

        const readStream = sftp.createReadStream(remotePath);
        const writeStream = createWriteStream(finalLocalPath);

        writeStream.on('close', () => {
          sftp.end();
          resolve({
            success: true,
            remotePath,
            localPath: finalLocalPath,
            size: stats.size
          });
        });

        writeStream.on('error', (err) => {
          sftp.end();
          reject(err);
        });

        readStream.on('error', (err) => {
          sftp.end();
          reject(err);
        });

        readStream.pipe(writeStream);
      });
    });
  }

  /**
   * Write content directly to remote file
   * @param {string} remotePath - Remote file path
   * @param {string} content - Content to write
   * @returns {Promise<object>} Write result
   */
  async writeFile(remotePath, content) {
    if (!this._isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    const sftp = await this._getSFTP();

    return new Promise((resolve, reject) => {
      const writeStream = sftp.createWriteStream(remotePath);

      writeStream.on('close', () => {
        sftp.end();
        resolve({
          success: true,
          remotePath,
          size: Buffer.byteLength(content, 'utf8')
        });
      });

      writeStream.on('error', (err) => {
        sftp.end();
        reject(err);
      });

      writeStream.write(content);
      writeStream.end();
    });
  }

  /**
   * Read remote file content
   * @param {string} remotePath - Remote file path
   * @returns {Promise<object>} { success, remotePath, content, size }
   */
  async readFile(remotePath) {
    if (!this._isConnected()) {
      throw new Error('Not connected. Call connect() first.');
    }

    const sftp = await this._getSFTP();

    return new Promise((resolve, reject) => {
      let content = '';
      const readStream = sftp.createReadStream(remotePath);

      readStream.on('data', (chunk) => {
        content += chunk.toString('utf8');
      });

      readStream.on('end', () => {
        sftp.end();
        resolve({
          success: true,
          remotePath,
          content,
          size: Buffer.byteLength(content, 'utf8')
        });
      });

      readStream.on('error', (err) => {
        sftp.end();
        reject(err);
      });
    });
  }
}
