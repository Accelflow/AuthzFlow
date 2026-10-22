#ifndef AUTHZFLOW_NATIVE_H
#define AUTHZFLOW_NATIVE_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* UTF-8 JSON input <= 1 MiB. Result belongs to Rust; release exactly once. */
char *authzflow_native_call(const unsigned char *input, size_t length);
void authzflow_native_free(char *output);
#ifdef __cplusplus
}
#endif
#endif
