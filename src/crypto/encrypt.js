'use strict';

/**
 * Hybrid encryption: AES-256-GCM (for arbitrary-length plaintext)
 * + RSA-OAEP (to encrypt the AES key).
 */

const crypto = require('crypto');

/**
 * RSA encryption needs something called padding.
 * Padding is extra data added before encryption to make RSA secure.
 */
const RSA_PADDING = crypto.constants.RSA_PKCS1_OAEP_PADDING;

/**
 * OAEP is a padding scheme for RSA encryption.
 * It uses a hash function (SHA-256) to add randomness and security.
 */

const OAEP_HASH = 'sha256';

//The crypto functions expect binary data, not strings.

/**
 * Encrypt a plaintext string for a recipient.
 *
 * @param {string} plaintext - The message to encrypt
 * @param {string} recipientPublicKeyPem - Recipient's RSA public key (PEM)
 * @returns {{ encryptedKey: string, iv: string, tag: string, ciphertext: string }}
 */
function encrypt(plaintext, recipientPublicKeyPem) {

    //Generate a fresh random AES-256 key for this message only
    const aesKey = crypto.randomBytes(32); // 256-bit
    const iv = crypto.randomBytes(12);     // 96-bit IV for GCM

    // Encrypt plaintext with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv); // in decryption this process will happen secondly, then down one(Interms of decryption)
    const ciphertextBuf = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag(); // while encrypting, we also generate a 16-byte authentication tag

    // Encrypt the AES key with the recipient's RSA public key
    const encryptedKey = crypto.publicEncrypt(
        {
            key: recipientPublicKeyPem, //hence this should also be binary-data?
            padding: RSA_PADDING,
            oaepHash: OAEP_HASH,
        },
        aesKey
    );

    return {
        encryptedKey: encryptedKey.toString('hex'),
        iv: iv.toString('hex'),//be careful with this syntax, dont cconfuse with the Buffer.from(string, 'hex')
        tag: tag.toString('hex'),
        ciphertext: ciphertextBuf.toString('hex'),
    };
}

/**
 * Decrypt a payload produced by encrypt().
 *
 * @param {{ encryptedKey: string, iv: string, tag: string, ciphertext: string }} payload
 * @param {string} privateKeyPem - Recipient's RSA private key (PEM)
 * @returns {string} - Decrypted plaintext
 */
function decrypt(payload, privateKeyPem) { //payload is the encrypted message
    const { encryptedKey, iv, tag, ciphertext } = payload;

    //unlocking rsa stuff
    const aesKey = crypto.privateDecrypt(
        {
            key: privateKeyPem,
            padding: RSA_PADDING,
            oaepHash: OAEP_HASH,
        },
        Buffer.from(encryptedKey, 'hex')
    );

    // creating a decryption engine
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        aesKey,
        Buffer.from(iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tag, 'hex'));

    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'hex')),
        decipher.final(),
    ]);

    return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
