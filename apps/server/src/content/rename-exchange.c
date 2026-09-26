#define _GNU_SOURCE
#include <errno.h>
#include <linux/fs.h>
#include <node_api.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

static napi_value exchange(napi_env env, napi_callback_info info) {
  napi_value args[4];
  size_t argc = 4;
  int32_t old_dir, new_dir;
  char old_name[256], new_name[256];
  size_t old_len, new_len;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 4 ||
      napi_get_value_int32(env, args[0], &old_dir) != napi_ok ||
      napi_get_value_int32(env, args[2], &new_dir) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], old_name, sizeof(old_name), &old_len) != napi_ok ||
      napi_get_value_string_utf8(env, args[3], new_name, sizeof(new_name), &new_len) != napi_ok ||
      old_len == 0 || new_len == 0 || old_len >= sizeof(old_name) - 1 ||
      new_len >= sizeof(new_name) - 1 || strchr(old_name, '/') || strchr(new_name, '/')) {
    napi_throw_type_error(env, NULL, "Invalid rename exchange arguments");
    return NULL;
  }
  if (syscall(SYS_renameat2, old_dir, old_name, new_dir, new_name, RENAME_EXCHANGE) != 0) {
    napi_throw_error(env, NULL, strerror(errno));
    return NULL;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_value method;
  napi_create_function(env, "exchange", NAPI_AUTO_LENGTH, exchange, NULL, &method);
  napi_set_named_property(env, exports, "exchange", method);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
