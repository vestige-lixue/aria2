#!/usr/bin/env bash
set -euo pipefail

builder="$(cd "$(dirname "$0")/.." && pwd)"
upstream="$(cd "$builder/../upstream" && pwd)"
target="$TARGET_PLATFORM-$TARGET_ARCH"
case "$target" in
  win32-x64|win32-arm64|darwin-x64|darwin-arm64|linux-x64|linux-arm64) ;;
  *) echo "Unsupported target: $target" >&2; exit 1 ;;
esac
actual_commit="$(git -c safe.directory="$upstream" -C "$upstream" rev-parse HEAD)"
[[ "$actual_commit" == "$ARIA2_COMMIT" ]]
work="$builder/.work/$target"
prefix="$work/prefix"
python3 "$builder/scripts/inputs.py" fetch
mkdir -p "$prefix/lib/pkgconfig" "$prefix/include" "$work/aria2-build"
jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.logicalcpu)"
export CC=cc CXX=c++ AR=ar RANLIB=ranlib STRIP=strip
export CFLAGS="-O2" CXXFLAGS="-O2"
export CPPFLAGS="-I$prefix/include" LDFLAGS="-L$prefix/lib"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export PKG_CONFIG="pkg-config --static"
host_args=()
tls_args=()
if [[ "$TARGET_PLATFORM" == win32 ]]; then
  export PATH="$work/toolchain/bin:$PATH"
  if [[ "$TARGET_ARCH" == x64 ]]; then host=x86_64-w64-mingw32; else host=aarch64-w64-mingw32; fi
  export CC="$host-clang" CXX="$host-clang++" AR="$host-ar" RANLIB="$host-ranlib" STRIP="$host-strip"
  export RC="$host-windres" WINDRES="$host-windres"
  export CPPFLAGS="$CPPFLAGS -DCARES_STATICLIB -DXML_STATIC"
  export LDFLAGS="$LDFLAGS -static"
  # All supported Windows versions provide these functions. Avoid the obsolete
  # bundled fallback being selected by an unexecutable cross-compile probe.
  export ac_cv_func_getaddrinfo=yes ac_cv_func_gai_strerror=yes
  host_args=("--host=$host")
  tls_args=(--with-wintls --without-appletls --without-openssl --with-libgmp)
elif [[ "$TARGET_PLATFORM" == darwin ]]; then
  export MACOSX_DEPLOYMENT_TARGET="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["macosDeploymentTarget"])' "$builder/dependencies.json")"
  if [[ "$TARGET_ARCH" == x64 ]]; then cpu=x86_64; else cpu=arm64; fi
  [[ "$(uname -m)" == "$cpu" ]]
  export CFLAGS="$CFLAGS -arch $cpu -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
  export CXXFLAGS="$CXXFLAGS -arch $cpu -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
  export LDFLAGS="$LDFLAGS -arch $cpu -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET"
  tls_args=(--with-appletls --without-wintls --without-openssl --with-libgmp)
else
  if [[ "$TARGET_ARCH" == x64 ]]; then cpu=x86_64; else cpu=aarch64; fi
  [[ "$(uname -m)" == "$cpu" ]]
  [[ -f /etc/alpine-release ]]
  expected_gcc="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["linuxRuntimeNotices"]["gcc-license"]["version"])' "$builder/dependencies.json")"
  expected_musl="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["linuxRuntimeNotices"]["musl"]["version"])' "$builder/dependencies.json")"
  [[ "$(gcc -dumpfullversion)" == "$expected_gcc" ]]
  apk info -v musl | grep -q "^musl-$expected_musl-r"
  export LDFLAGS="$LDFLAGS -static"
  tls_args=(--with-openssl --without-appletls --without-wintls --without-libgmp)
fi

autoconf_library() {
  local name="$1"
  shift
  (
    cd "$work/src/$name"
    ./configure "${host_args[@]}" --prefix="$prefix" --libdir="$prefix/lib" \
      --enable-static --disable-shared "$@"
    make -j"$jobs"
    make install
  )
}

# Build every non-system dependency from the checked source archives. Homebrew
# supplies build tools only; its runtime libraries must never enter the package.
if [[ "$TARGET_PLATFORM" == win32 ]]; then
  (
    cd "$work/src/zlib"
    make -f win32/Makefile.gcc -j"$jobs" CC="$CC" AR="$AR" RC="$RC" libz.a
    cp libz.a "$prefix/lib/"
    cp zlib.h zconf.h "$prefix/include/"
    version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sources"]["zlib"]["version"])' "$builder/dependencies.json")"
    printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\nName: zlib\nDescription: zlib\nVersion: %s\nLibs: -L${libdir} -lz\nCflags: -I${includedir}\n' \
      "$prefix" "$version" > "$prefix/lib/pkgconfig/zlib.pc"
  )
else
  (cd "$work/src/zlib"; ./configure --static --prefix="$prefix"; make -j"$jobs"; make install)
fi
autoconf_library cares --disable-tests
autoconf_library expat --without-docbook --without-xmlwf --without-examples --without-tests

# Compile SQLite's amalgamation directly, avoiding optional shell/Tcl/readline
# tools while preserving aria2's Firefox cookie reader.
(
  cd "$work/src/sqlite"
  # These flag variables deliberately contain separate compiler arguments.
  "$CC" $CFLAGS $CPPFLAGS -DSQLITE_THREADSAFE=1 -DSQLITE_OMIT_LOAD_EXTENSION -c sqlite3.c -o sqlite3.o
  "$AR" rcs "$prefix/lib/libsqlite3.a" sqlite3.o
  cp sqlite3.h sqlite3ext.h "$prefix/include/"
  version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["sources"]["sqlite"]["version"])' "$builder/dependencies.json")"
  private_libs='-lpthread -lm'
  if [[ "$TARGET_PLATFORM" == win32 ]]; then private_libs=''; fi
  printf 'prefix=%s\nlibdir=${prefix}/lib\nincludedir=${prefix}/include\nName: SQLite\nDescription: SQLite\nVersion: %s\nLibs: -L${libdir} -lsqlite3\nLibs.private: %s\nCflags: -I${includedir}\n' \
    "$prefix" "$version" "$private_libs" > "$prefix/lib/pkgconfig/sqlite3.pc"
)

if [[ "$TARGET_PLATFORM" != linux ]]; then
  autoconf_library gmp --disable-cxx --disable-assembly
fi
if [[ "$TARGET_PLATFORM" != win32 ]]; then
  case "$target" in
    linux-x64) openssl_target=linux-x86_64 ;;
    linux-arm64) openssl_target=linux-aarch64 ;;
    darwin-x64) openssl_target=darwin64-x86_64-cc ;;
    darwin-arm64) openssl_target=darwin64-arm64-cc ;;
  esac
  (
    cd "$work/src/openssl"
    ./Configure "$openssl_target" --prefix="$prefix" --libdir=lib --openssldir=/etc/ssl \
      no-shared no-tests no-module no-engine
    make -j"$jobs"
    make install_sw
  )
  autoconf_library libssh2 --with-crypto=openssl --disable-examples-build
else
  autoconf_library libssh2 --with-crypto=wincng --enable-ecdsa-wincng --disable-examples-build
fi

# A Git checkout, pinned to the resolved upstream commit, keeps generated
# configure files from hiding a different source revision in a release tarball.
export CFLAGS="$CFLAGS -std=gnu11"
(cd "$upstream"; autoreconf -fi)
(
  cd "$work/aria2-build"
  "$upstream/configure" "${host_args[@]}" "${tls_args[@]}" \
    --prefix="$prefix" --enable-static --disable-shared --disable-nls --disable-werror \
    --enable-bittorrent --enable-metalink --enable-websocket --disable-libaria2 \
    --with-libz --with-libcares --with-libexpat --with-sqlite3 --with-libssh2 \
    --without-libxml2 --without-gnutls --without-libnettle --without-libgcrypt \
    --without-libuv --without-tcmalloc --without-jemalloc ARIA2_STATIC=yes
  # Build the CLI and its prerequisites, without upstream test or documentation targets.
  make -j"$jobs" -C deps/wslay
  make -j"$jobs" -C lib
  make -j"$jobs" -C src
)
binary="$work/aria2-build/src/aria2c"
if [[ "$TARGET_PLATFORM" == win32 ]]; then binary+=.exe; fi
"$STRIP" "$binary"
if [[ "$TARGET_PLATFORM" == darwin ]]; then codesign --force --sign - "$binary"; fi
python3 "$builder/scripts/inputs.py" package