#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/memfd.h>
#include <node_api.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/types.h>
#include <unistd.h>

/* A sealed Linux memfd keeps the executable inode stable across node-pty's fork/exec. */
static napi_value capture(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  size_t argc = 2, length;
  int64_t expected_size;
  char path[4096], buffer[65536];
  int source = -1, sealed = -1;
  struct stat metadata;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2 ||
      napi_get_value_string_utf8(env, args[0], path, sizeof(path), &length) != napi_ok ||
      napi_get_value_int64(env, args[1], &expected_size) != napi_ok ||
      expected_size <= 0 || expected_size > 536870912 ||
      length == 0 || length >= sizeof(path) - 1) {
    napi_throw_type_error(env, NULL, "Invalid executable path");
    return NULL;
  }
  source = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (source < 0 || fstat(source, &metadata) != 0 || !S_ISREG(metadata.st_mode) ||
      (metadata.st_mode & 0022) != 0 || metadata.st_size != expected_size) goto error;
  sealed = memfd_create("agent-workspace-executable", MFD_CLOEXEC | MFD_ALLOW_SEALING);
  if (sealed < 0) goto error;
  int64_t copied = 0;
  for (;;) {
    ssize_t count = read(source, buffer, sizeof(buffer));
    if (count < 0) { if (errno == EINTR) continue; goto error; }
    if (count == 0) break;
    copied += count;
    if (copied > expected_size) { errno = EFBIG; goto error; }
    for (ssize_t offset = 0; offset < count;) {
      ssize_t written = write(sealed, buffer + offset, (size_t)(count - offset));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) goto error;
      offset += written;
    }
  }
  if (copied != expected_size) { errno = EIO; goto error; }
  if (fcntl(sealed, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL) != 0 ||
      lseek(sealed, 0, SEEK_SET) < 0) goto error;
  close(source);
  napi_create_int32(env, sealed, &result);
  return result;
error:
  { int saved = errno; if (source >= 0) close(source); if (sealed >= 0) close(sealed);
    napi_throw_error(env, NULL, strerror(saved)); return NULL; }
}

static napi_value verify(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  size_t argc = 1;
  int32_t fd;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, args[0], &fd) != napi_ok || fd < 0) {
    napi_throw_type_error(env, NULL, "Invalid sealed descriptor");
    return NULL;
  }
  int seals = fcntl(fd, F_GET_SEALS);
  if (seals < 0 || (seals & (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL)) !=
          (F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL)) {
    napi_throw_error(env, NULL, "Executable descriptor is not sealed");
    return NULL;
  }
  napi_get_boolean(env, true, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value method;
  napi_create_function(env, "capture", NAPI_AUTO_LENGTH, capture, NULL, &method);
  napi_set_named_property(env, exports, "capture", method);
  napi_create_function(env, "verify", NAPI_AUTO_LENGTH, verify, NULL, &method);
  napi_set_named_property(env, exports, "verify", method);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
