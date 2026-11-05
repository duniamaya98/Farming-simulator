import os
import sys
import json
import struct
import ast
import zlib
import urllib.request
import zipfile
import brotli
from hermes_dec.parsers.hbc_file_parser import HBCReader, parse_hbc_bytecode
from hermes_dec.parsers.serialized_literal_parser import unpack_slp_array, TagType
import hermes_dec.parsers.hbc_opcodes.hbc98 as hbc98

closure_opcodes = {
    'CreateClosure',
    'CreateClosureLongIndex',
    'CreateGenerator',
    'CreateGeneratorLongIndex',
    'CreateBaseClass',
    'CreateBaseClassLongIndex',
    'CreateDerivedClass',
    'CreateDerivedClassLongIndex'
}

def extract_bundle_to_oracle(bundle_path, out_meta_path, out_bc_path):
    print(f"[+] Membaca bundle Hermes: {bundle_path}")
    with open(bundle_path, 'rb') as f:
        r = HBCReader()
        r.read_whole_file(f)

        print(f"    - HBC Bytecode Version: {r.header.version}")
        print(f"    - Total fungsi di bundle: {len(r.function_headers)}")
        print(f"    - Total string: {len(r.strings)}")

        # 1. Tabel OPCODES
        max_op = max(hbc98._opcode_to_instruction.keys())
        opcodes = [None] * (max_op + 1)
        for op, inst in hbc98._opcode_to_instruction.items():
            opcodes[op] = [inst.name, [o.operand_type.name for o in inst.operands]]

        # 2. Cari fungsi rekursif dari modul Oracle (627..632)
        def get_called_fids(fid):
            children = set()
            fh = r.function_headers[fid]
            for inst in parse_hbc_bytecode(fh, r):
                if inst.inst.name in closure_opcodes:
                    args = [getattr(inst, f'arg{i+1}') for i in range(len(inst.inst.operands))]
                    child_fid = args[-1]
                    children.add(child_fid)
            return children

        visited = set()
        queue = list(range(627, 633))
        while queue:
            cur = queue.pop()
            if cur in visited or cur >= len(r.function_headers):
                continue
            visited.add(cur)
            for ch in get_called_fids(cur):
                if ch not in visited and ch < len(r.function_headers):
                    queue.append(ch)

        sorted_fids = sorted(visited)
        print(f"[+] Menemukan {len(sorted_fids)} fungsi modul Oracle yang saling terhubung.")

        # 3. Ekstrak bytecode dan metadata
        functions_meta = {}
        bc_bytes = bytearray()
        obj_needed = set()
        arr_needed = set()
        switch_tables = {}

        for fid in sorted_fids:
            fh = r.function_headers[fid]
            f.seek(fh.offset)
            raw_bc = f.read(fh.bytecodeSizeInBytes)
            
            bc_off = len(bc_bytes)
            bc_size = len(raw_bc)
            bc_bytes.extend(raw_bc)

            raw_exc = []
            if fid in r.function_id_to_exc_handlers:
                for h in r.function_id_to_exc_handlers[fid]:
                    raw_exc.append([h.start, h.end, h.target])

            functions_meta[str(fid)] = [bc_off, bc_size, fh.paramCount, fh.frameSize, raw_exc]

            for inst in parse_hbc_bytecode(fh, r):
                name = inst.inst.name
                if 'NewObjectWithBuffer' in name:
                    b_val = getattr(inst, 'arg2')
                    c_val = getattr(inst, 'arg3')
                    obj_needed.add((b_val, c_val))
                elif 'NewArrayWithBuffer' in name:
                    c_val = getattr(inst, 'arg3')
                    d_val = getattr(inst, 'arg4')
                    arr_needed.add((c_val, d_val))
                elif inst.inst.opcode == 167:  # StringSwitchImm
                    args = [getattr(inst, f'arg{i+1}') for i in range(len(inst.inst.operands))]
                    byte_off = inst.original_pos
                    tbl_offset = args[2]
                    def_offset = args[3]
                    num_cases = args[4]
                    tbl_file_pos = (fh.offset + byte_off + 1 + tbl_offset + 3) & ~3
                    f.seek(tbl_file_pos)
                    cases = {}
                    for _ in range(num_cases):
                        s_idx, t_offset = struct.unpack('<II', f.read(8))
                        s = r.strings[s_idx]
                        cases[s] = byte_off + t_offset
                    def_byte = byte_off + def_offset
                    switch_tables[f"{fid}:{byte_off}"] = [cases, def_byte]

        print(f"[+] Bytecode Oracle berhasil dirangkum: {len(bc_bytes):,} byte.")

        def slp_val_to_json(val):
            if val.tag_type == TagType.NullTag:
                return None
            elif val.tag_type == TagType.TrueTag:
                return True
            elif val.tag_type == TagType.FalseTag:
                return False
            elif val.tag_type == TagType.UndefinedTag:
                return "__HBC_UNDEFINED__"
            elif val.tag_type == TagType.NumberTag or val.tag_type == TagType.IntegerTag:
                return val.value
            elif val.tag_type in (TagType.LongStringTag, TagType.ShortStringTag, TagType.ByteStringTag):
                return r.strings[val.value]
            else:
                raise ValueError(f"Unknown tag type {val.tag_type}")

        # 4. Templates
        obj_templates = {}
        for shape_idx, val_off in obj_needed:
            raw_keys = r.object_shape_keys[shape_idx]
            clean_keys = [ast.literal_eval(k) for k in raw_keys]
            unpacked_vals = unpack_slp_array(r.literal_values[val_off:], len(clean_keys), r.header.version)
            vals = [slp_val_to_json(v) for v in unpacked_vals.items]
            obj_templates[f"{shape_idx}:{val_off}"] = [clean_keys, vals]

        arr_templates = {}
        for num_elems, val_off in arr_needed:
            unpacked_vals = unpack_slp_array(r.literal_values[val_off:], num_elems, r.header.version)
            vals = [slp_val_to_json(v) for v in unpacked_vals.items]
            arr_templates[f"{num_elems}:{val_off}"] = vals

        # 5. Tulis output
        os.makedirs(os.path.dirname(out_bc_path), exist_ok=True)
        with open(out_bc_path, 'wb') as f_out:
            f_out.write(bc_bytes)

        meta = {
            "opcodes": opcodes,
            "strings": r.strings,
            "functions": functions_meta,
            "objTemplates": obj_templates,
            "arrTemplates": arr_templates,
            "switchTables": switch_tables
        }

        os.makedirs(os.path.dirname(out_meta_path), exist_ok=True)
        with open(out_meta_path, 'w', encoding='utf-8') as f_out:
            json.dump(meta, f_out, ensure_ascii=False)

        print(f"[OK] Berhasil menyimpan:")
        print(f"     - {out_bc_path}")
        print(f"     - {out_meta_path} ({os.path.getsize(out_meta_path):,} byte)")

def extract_from_apk(apk_path, out_dir):
    print(f"[+] Mengekstrak bundle bawaan dari APK: {apk_path}")
    with zipfile.ZipFile(apk_path, 'r') as z:
        if 'assets/index.android.bundle' not in z.namelist():
            raise FileNotFoundError("assets/index.android.bundle tidak ditemukan di dalam APK")
        data = z.read('assets/index.android.bundle')
        bundle_path = os.path.join(out_dir, "index.android.bundle.apk")
        with open(bundle_path, 'wb') as f:
            f.write(data)
        print(f"[OK] Tersimpan di: {bundle_path} ({len(data):,} byte)")
        return bundle_path

def download_latest_ota(fingerprint="c57ca294975fd60aa95a41af2dd0cad363e49f9f", out_dir="assets"):
    check_url = f"https://updates.ninjahorizon.com/api/check-update/fingerprint/android/{fingerprint}/production/0/0"
    print(f"[+] Memeriksa bundle HotUpdater OTA terbaru...")
    req = urllib.request.Request(check_url, headers={"User-Agent": "okhttp/4.9.2"})
    with urllib.request.urlopen(req) as resp:
        info = json.loads(resp.read().decode())
    
    if not info or "fileUrl" not in info:
        print("[!] Tidak ada update OTA baru, menggunakan bundle APK.")
        return None

    bundle_id = info.get("id")
    msg = info.get("message")
    file_url = info.get("fileUrl")
    print(f"[+] Ditemukan bundle OTA aktif: {bundle_id} (\"{msg}\")")
    print(f"[+] Mengunduh bundle OTA...")

    req2 = urllib.request.Request(file_url, headers={"User-Agent": "okhttp/4.9.2"})
    with urllib.request.urlopen(req2) as resp:
        compressed = resp.read()

    print(f"[+] Mendekompresi Brotli tar archive ({len(compressed):,} byte)...")
    decompressed = brotli.decompress(compressed)

    import tarfile, io
    tar = tarfile.open(fileobj=io.BytesIO(decompressed))
    member = tar.getmember("index.android.bundle")
    bundle_data = tar.extractfile(member).read()

    os.makedirs(out_dir, exist_ok=True)
    ota_path = os.path.join(out_dir, "index.android.bundle.ota")
    with open(ota_path, 'wb') as f:
        f.write(bundle_data)
    print(f"[OK] Bundle OTA terbaru siap di: {ota_path} ({len(bundle_data):,} byte)")
    return ota_path

def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(base_dir, ".."))
    apk_path = os.path.join(project_root, "Ninja Horizon.apk")
    assets_dir = os.path.join(project_root, "assets")

    if not os.path.exists(apk_path):
        print(f"[ERR] File APK tidak ditemukan di: {apk_path}")
        sys.exit(1)

    # 1. Ekstrak bundle APK
    apk_bundle = extract_from_apk(apk_path, assets_dir)

    # 2. Cek & download bundle OTA terbaru (karena server memerlukan engine aktif terbaru)
    ota_bundle = None
    try:
        ota_bundle = download_latest_ota(out_dir=assets_dir)
    except Exception as e:
        print(f"[WARN] Gagal mengunduh bundle OTA ({e}), fallback ke bundle APK.")

    target_bundle = ota_bundle if ota_bundle and os.path.exists(ota_bundle) else apk_bundle

    # 3. Ekstrak Oracle Engine bytecode & metadata
    meta_path = os.path.join(base_dir, "oracle_meta.json")
    bc_path = os.path.join(base_dir, "oracle_bytecode.bin")
    extract_bundle_to_oracle(target_bundle, meta_path, bc_path)

    # 4. Ekstrak legacy APK engine ke folder legacy_apk_engines jika bundle APK berbeda
    if ota_bundle and os.path.exists(apk_bundle):
        legacy_dir = os.path.join(base_dir, "legacy_apk_engines")
        legacy_meta = os.path.join(legacy_dir, "oracle_meta.json")
        legacy_bc = os.path.join(legacy_dir, "oracle_bytecode.bin")
        print("\n[+] Mengekstrak engine bawaan APK ke folder legacy...")
        try:
            extract_bundle_to_oracle(apk_bundle, legacy_meta, legacy_bc)
        except Exception as e:
            print(f"[WARN] Gagal ekstrak legacy APK engine: {e}")

    print("\n[SELESAI] Ekstraksi berhasil! Silakan jalankan 'node bot.js --test-sim' untuk memverifikasi.")

if __name__ == "__main__":
    main()
