import { randomUUID } from 'node:crypto'
import { blake3 } from '@noble/hashes/blake3.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'

export function keyedIndexHash(key: Buffer, value: string): Buffer {
  if (key.length !== 32) throw new Error('Invalid index key')
  return Buffer.from(blake3(Buffer.from(value), { key }))
}

/** Exact Rust XChaCha20-Poly1305 format: 24-byte nonce and ciphertext with trailing 16-byte tag. */
export function encryptIndexValue(
  key: Buffer,
  value: Buffer
): { nonce: Buffer; ciphertext: Buffer } {
  if (key.length !== 32) throw new Error('Invalid index key')
  const nonceBytes = Buffer.from(randomUUID().replaceAll('-', ''), 'hex')
  const nonce = Buffer.concat([nonceBytes, Buffer.from(blake3(nonceBytes)).subarray(0, 8)])
  return { nonce, ciphertext: Buffer.from(xchacha20poly1305(key, nonce).encrypt(value)) }
}

export function decryptIndexValue(key: Buffer, nonce: Buffer, ciphertext: Buffer): Buffer {
  if (key.length !== 32 || nonce.length !== 24 || ciphertext.length < 16)
    throw new Error('Invalid encrypted index value')
  return Buffer.from(xchacha20poly1305(key, nonce).decrypt(ciphertext))
}
