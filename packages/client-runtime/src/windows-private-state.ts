import type koffiModule from 'koffi'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'

function loadApi() {
  const koffi = createRequire(import.meta.url)('koffi') as typeof koffiModule
  const SECURITY_ATTRIBUTES = koffi.struct('SECURITY_ATTRIBUTES', {
    nLength: 'uint32',
    lpSecurityDescriptor: 'void *',
    bInheritHandle: 'int32'
  })
  koffi.struct('PRIVATE_FILE_INFORMATION', {
    attributes: 'uint32',
    creationLow: 'uint32',
    creationHigh: 'uint32',
    accessLow: 'uint32',
    accessHigh: 'uint32',
    writeLow: 'uint32',
    writeHigh: 'uint32',
    volume: 'uint32',
    sizeHigh: 'uint32',
    sizeLow: 'uint32',
    links: 'uint32',
    indexHigh: 'uint32',
    indexLow: 'uint32'
  })
  const ACL_INFORMATION = koffi.struct('PRIVATE_ACL_INFORMATION', {
    count: 'uint32',
    used: 'uint32',
    free: 'uint32'
  })
  const ACE_HEADER = koffi.struct('PRIVATE_ACE_HEADER', {
    type: 'uint8',
    flags: 'uint8',
    size: 'uint16',
    mask: 'uint32'
  })
  koffi.struct('PRIVATE_OVERLAPPED', {
    Internal: 'uintptr_t',
    InternalHigh: 'uintptr_t',
    Offset: 'uint32',
    OffsetHigh: 'uint32',
    hEvent: 'void *'
  })

  const kernel = koffi.load('kernel32.dll')
  const security = koffi.load('advapi32.dll')
  return {
    koffi,
    SECURITY_ATTRIBUTES,
    ACL_INFORMATION,
    ACE_HEADER,
    close: kernel.func('bool __stdcall CloseHandle(void *)') as (handle: unknown) => boolean,
    createFile: kernel.func(
      'void * __stdcall CreateFileW(str16, uint32, uint32, SECURITY_ATTRIBUTES *, uint32, uint32, void *)'
    ) as (
      path: string,
      access: number,
      share: number,
      attributes: unknown,
      disposition: number,
      flags: number,
      template: null
    ) => bigint,
    createDirectory: kernel.func(
      'bool __stdcall CreateDirectoryW(str16, SECURITY_ATTRIBUTES *)'
    ) as (path: string, attributes: unknown) => boolean,
    fileInformation: kernel.func(
      'bool __stdcall GetFileInformationByHandle(void *, _Out_ PRIVATE_FILE_INFORMATION *)'
    ) as (handle: bigint, information: Record<string, number>) => boolean,
    lock: kernel.func(
      'bool __stdcall LockFileEx(void *, uint32, uint32, uint32, uint32, _Inout_ PRIVATE_OVERLAPPED *)'
    ) as (
      handle: bigint,
      flags: number,
      reserved: number,
      low: number,
      high: number,
      overlapped: unknown
    ) => boolean,
    lastError: kernel.func('uint32 __stdcall GetLastError()') as () => number,
    free: kernel.func('void * __stdcall LocalFree(void *)') as (allocation: unknown) => unknown,
    currentProcess: kernel.func('void * __stdcall GetCurrentProcess()') as () => bigint,
    processToken: security.func(
      'bool __stdcall OpenProcessToken(void *, uint32, _Out_ void **)'
    ) as (process: bigint, access: number, token: unknown[]) => boolean,
    tokenInformation: security.func(
      'bool __stdcall GetTokenInformation(void *, int32, void *, uint32, _Out_ uint32 *)'
    ) as (token: unknown, kind: number, buffer: unknown, size: number, length: number[]) => boolean,
    sidText: security.func('bool __stdcall ConvertSidToStringSidW(void *, _Out_ void **)') as (
      sid: bigint,
      text: unknown[]
    ) => boolean,
    descriptor: security.func(
      'bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32, _Out_ void **, _Out_ uint32 *)'
    ) as (sddl: string, revision: number, descriptor: unknown[], length: number[]) => boolean,
    securityInfo: security.func(
      'uint32 __stdcall GetSecurityInfo(void *, int32, uint32, _Out_ void **, void *, _Out_ void **, void *, _Out_ void **)'
    ) as (
      handle: bigint,
      kind: number,
      requested: number,
      owner: unknown[],
      group: null,
      dacl: unknown[],
      sacl: null,
      descriptor: unknown[]
    ) => number,
    descriptorControl: security.func(
      'bool __stdcall GetSecurityDescriptorControl(void *, _Out_ uint16 *, _Out_ uint32 *)'
    ) as (descriptor: unknown, control: number[], revision: number[]) => boolean,
    equalSid: security.func('bool __stdcall EqualSid(void *, void *)') as (
      a: unknown,
      b: unknown
    ) => boolean,
    aclInformation: security.func(
      'bool __stdcall GetAclInformation(void *, _Out_ PRIVATE_ACL_INFORMATION *, uint32, int32)'
    ) as (acl: unknown, information: Record<string, number>, size: number, kind: number) => boolean,
    ace: security.func('bool __stdcall GetAce(void *, uint32, _Out_ void **)') as (
      acl: unknown,
      index: number,
      ace: unknown[]
    ) => boolean
  }
}

let windowsApi: ReturnType<typeof loadApi> | undefined
function api(): ReturnType<typeof loadApi> {
  if (process.platform !== 'win32') throw new Error('Windows private state requires Windows')
  return (windowsApi ??= loadApi())
}

function pathError(win: ReturnType<typeof api>, message: string): Error {
  const error = win.lastError()
  const code =
    error === 2 || error === 3 ? 'ENOENT' : error === 80 || error === 183 ? 'EEXIST' : 'EACCES'
  return Object.assign(new Error(`${message} (Windows error ${error})`), { code })
}

function invalid(handle: bigint): boolean {
  return handle === -1n || handle === 0xffffffffffffffffn
}

function withUserSid<T>(win: ReturnType<typeof api>, operation: (sid: bigint) => T): T {
  const token: unknown[] = [null]
  if (!win.processToken(win.currentProcess(), 8, token))
    throw new Error('Unable to read Windows user token')
  let data: unknown
  try {
    const length = [0]
    win.tokenInformation(token[0], 1, null, 0, length)
    if (!length[0]) throw new Error('Unable to size Windows user token')
    data = win.koffi.alloc('uint8', length[0])
    if (!win.tokenInformation(token[0], 1, data, length[0], length))
      throw new Error('Unable to read Windows user token')
    return operation(win.koffi.decode(data, 'void *') as bigint)
  } finally {
    if (data) win.koffi.free(data)
    win.close(token[0])
  }
}

function privateDescriptor(win: ReturnType<typeof api>, directory: boolean): unknown {
  return withUserSid(win, (sid) => {
    const text: unknown[] = [null]
    if (!win.sidText(sid, text)) throw new Error('Unable to format Windows user SID')
    try {
      const owner = win.koffi.decode(text[0], 'str16') as string
      const descriptor: unknown[] = [null]
      if (
        !win.descriptor(
          `O:${owner}D:P(A;${directory ? 'OICI' : ''};FA;;;${owner})`,
          1,
          descriptor,
          [0]
        )
      )
        throw new Error('Unable to create Windows private DACL')
      return descriptor[0]
    } finally {
      win.free(text[0])
    }
  })
}

function canonical(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error('Windows private path must be absolute and canonical')
}

function assertPrivateHandle(
  win: ReturnType<typeof api>,
  handle: bigint,
  directory: boolean
): string {
  const info = {
    attributes: 0,
    creationLow: 0,
    creationHigh: 0,
    accessLow: 0,
    accessHigh: 0,
    writeLow: 0,
    writeHigh: 0,
    volume: 0,
    sizeHigh: 0,
    sizeLow: 0,
    links: 0,
    indexHigh: 0,
    indexLow: 0
  }
  if (
    !win.fileInformation(handle, info) ||
    (info.attributes & 0x400) !== 0 ||
    ((info.attributes & 0x10) !== 0) !== directory ||
    (!directory && info.links !== 1)
  )
    throw new Error(
      'Windows private path must be a regular path without reparse points or hard links'
    )
  const owner: unknown[] = [null]
  const dacl: unknown[] = [null]
  const descriptor: unknown[] = [null]
  if (win.securityInfo(handle, 1, 5, owner, null, dacl, null, descriptor) !== 0)
    throw new Error('Unable to inspect Windows private DACL')
  try {
    const control = [0]
    if (
      !win.descriptorControl(descriptor[0], control, [0]) ||
      (directory && (control[0]! & 0x1000) === 0)
    )
      throw new Error('Windows private directory must have a protected DACL')
    const acl = { count: 0, used: 0, free: 0 }
    if (
      !dacl[0] ||
      !win.aclInformation(dacl[0], acl, win.koffi.sizeof(win.ACL_INFORMATION), 2) ||
      acl.count !== 1
    )
      throw new Error('Windows private DACL is not owner-only')
    const ace: unknown[] = [null]
    if (!win.ace(dacl[0], 0, ace) || !ace[0])
      throw new Error('Unable to inspect Windows private ACE')
    const header = win.koffi.decode(ace[0], win.ACE_HEADER) as {
      type: number
      size: number
      mask: number
    }
    if (header.type !== 0 || header.size < 20 || (header.mask & 0x1f01ff) !== 0x1f01ff)
      throw new Error('Windows private DACL must grant its owner full control')
    // SidStart is inline after the ACE header and access mask, not a pointer field.
    const aceSid = (ace[0] as bigint) + 8n
    withUserSid(win, (sid) => {
      if (!win.equalSid(owner[0], sid) || !win.equalSid(aceSid, sid))
        throw new Error('Windows private path is not owned by this user')
    })
    return `${info.volume}:${info.indexHigh}:${info.indexLow}`
  } finally {
    win.free(descriptor[0])
  }
}

/** Create protected state directories without granting inherited access to other users. */
export function ensureWindowsPrivateDirectory(path: string): void {
  canonical(path)
  const win = api()
  const descriptor = privateDescriptor(win, true)
  try {
    const attributes = {
      nLength: win.koffi.sizeof(win.SECURITY_ATTRIBUTES),
      lpSecurityDescriptor: descriptor,
      bInheritHandle: 0
    }
    if (!win.createDirectory(path, attributes) && win.lastError() !== 183)
      throw pathError(win, 'Unable to create Windows private directory')
  } finally {
    win.free(descriptor)
  }
  assertWindowsPrivatePath(path, true)
}

/** Validate the current user's DACL and return the handle's stable file identity. */
export function assertWindowsPrivatePath(path: string, directory = false): string {
  canonical(path)
  const win = api()
  const handle = win.createFile(
    path,
    0x20080,
    7,
    null,
    3,
    0x00200000 | (directory ? 0x02000000 : 0x80),
    null
  )
  if (invalid(handle)) throw pathError(win, 'Windows private path cannot be opened')
  try {
    return assertPrivateHandle(win, handle, directory)
  } finally {
    win.close(handle)
  }
}

export function createWindowsPrivateFile(path: string): void {
  ensureWindowsPrivateDirectory(dirname(path))
  const win = api()
  const descriptor = privateDescriptor(win, false)
  try {
    const attributes = {
      nLength: win.koffi.sizeof(win.SECURITY_ATTRIBUTES),
      lpSecurityDescriptor: descriptor,
      bInheritHandle: 0
    }
    const handle = win.createFile(path, 0x40000000, 0, attributes, 1, 0x00200080, null)
    if (invalid(handle)) throw pathError(win, 'Unable to create Windows private file')
    win.close(handle)
  } finally {
    win.free(descriptor)
  }
  assertWindowsPrivatePath(path)
}

/** Both the OS lock and unshared handle are released automatically on process death. */
export function acquireWindowsPrivateLock(path: string): { close(): void } {
  ensureWindowsPrivateDirectory(dirname(path))
  const win = api()
  const descriptor = privateDescriptor(win, false)
  let handle: bigint
  try {
    const attributes = {
      nLength: win.koffi.sizeof(win.SECURITY_ATTRIBUTES),
      lpSecurityDescriptor: descriptor,
      bInheritHandle: 0
    }
    handle = win.createFile(path, 0xc0020080, 0, attributes, 4, 0x00200080, null)
    if (invalid(handle)) {
      if (win.lastError() === 32 || win.lastError() === 33)
        throw new Error('Windows private lock is already owned')
      throw pathError(win, 'Unable to open Windows private lock')
    }
  } finally {
    win.free(descriptor)
  }
  try {
    assertPrivateHandle(win, handle, false)
    const overlapped = { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: null }
    if (!win.lock(handle, 3, 0, 0xffffffff, 0xffffffff, overlapped))
      throw new Error('Windows private lock is already owned')
  } catch (error) {
    win.close(handle)
    throw error
  }
  let closed = false
  return {
    close() {
      if (!closed) {
        closed = true
        win.close(handle)
      }
    }
  }
}
