import importlib.util
import io
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('inputs', Path(__file__).resolve().parents[1] / 'scripts' / 'inputs.py')
inputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inputs)


def elf(machine=62, segment=0, dynamic_tag=0):
    data = bytearray(160)
    data[:6] = b'\x7fELF\x02\x01'
    struct.pack_into('<H', data, 18, machine)
    struct.pack_into('<Q', data, 32, 64)
    struct.pack_into('<HH', data, 54, 56, 1)
    struct.pack_into('<I', data, 64, segment)
    struct.pack_into('<Q', data, 72, 128)
    struct.pack_into('<Q', data, 96, 16)
    struct.pack_into('<Q', data, 128, dynamic_tag)
    return bytes(data)


class InputsTest(unittest.TestCase):
    def test_every_dependency_has_a_pinned_https_source(self):
        locked = inputs.config()
        self.assertEqual(set(locked['sources']), {'zlib', 'cares', 'expat', 'gmp', 'sqlite', 'openssl', 'libssh2'})

    def test_wrong_elf_architecture_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'architecture'):
            inputs.inspect_binary(elf(machine=183), 'linux', 'x64')

    def test_dynamic_loader_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'dynamic loader'):
            inputs.inspect_binary(elf(segment=3), 'linux', 'x64')

    def test_shared_library_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'DT_NEEDED'):
            inputs.inspect_binary(elf(segment=2, dynamic_tag=1), 'linux', 'x64')

    def test_static_pie_without_shared_libraries_is_accepted(self):
        self.assertEqual(inputs.inspect_binary(elf(segment=2), 'linux', 'x64')['linkage'], 'static-musl')

    def test_installed_apk_packages_are_read_from_the_database(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'installed'
            database.write_text('C:Q1abc=\nP:musl\nV:1.2.5-r24\nA:x86_64\n\nP:libgcc\nV:15.2.0-r2\n\n'
                                'P:libstdc++\nV:15.2.0-r2\n', encoding='utf-8')
            self.assertEqual(inputs.installed_apk_packages(['musl', 'libgcc', 'libstdc++'], database),
                             ['musl-1.2.5-r24', 'libgcc-15.2.0-r2', 'libstdc++-15.2.0-r2'])
            with self.assertRaisesRegex(ValueError, 'not found'):
                inputs.installed_apk_packages(['openssl'], database)

    def test_traversal_and_windows_paths_are_rejected(self):
        for name in ('../outside', '/absolute', 'root/../../outside', 'C:/file', 'root\\file'):
            with self.subTest(name=name), self.assertRaises(ValueError):
                inputs.safe_name(name)

    def test_archive_traversal_is_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'bad.tar.gz'
            with tarfile.open(archive, 'w:gz') as bundle:
                info = tarfile.TarInfo('root/../../outside')
                info.size = 1
                bundle.addfile(info, io.BytesIO(b'x'))
            with self.assertRaises(ValueError):
                inputs.extract_source(archive, root / 'source')
            self.assertFalse((root / 'source').exists())

    def test_existing_source_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / 'source'
            destination.mkdir()
            (destination / 'edited').write_text('keep')
            with self.assertRaisesRegex(ValueError, 'fresh work directory'):
                inputs.extract_source(root / 'absent.tar.gz', destination)
            self.assertEqual((destination / 'edited').read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()