#!/usr/bin/env python3
"""Standalone .blend parser: reads the SDNA and dumps the scene inventory.

No Blender required. Parses the documented .blend block format:
header -> [block: code, size, old_ptr, sdna_idx, count, data]* -> DNA1 -> ENDB
"""
import struct
import sys
from collections import defaultdict


class Blend:
    def __init__(self, path):
        self.f = open(path, "rb")
        self.buf = self.f.read()
        self._parse_header()
        self._parse_blocks()
        self._parse_dna()

    def _parse_header(self):
        h = self.buf[:17]
        # Blender 3.0+ writes zstd-compressed .blend by default, and 4.x/5.x use
        # a 17-byte header instead of the legacy 12. This parser understands
        # neither, and used to fail either with a confusing magic-mismatch or,
        # worse, by "succeeding" on a misread header and then dying on a missing
        # DNA1 block. Say so plainly instead: the current room.blend is 5.0.2 and
        # hits both cases.
        if self.buf[:4] == b"\x28\xb5\x2f\xfd":
            raise SystemExit(
                "this .blend is zstd-compressed (Blender 3.0+ default).\n"
                "  decompress first:  zstd -d room.blend -o /tmp/raw.blend\n"
                "  or just use bpy:   tools/.venv/bin/python -c \"import bpy; "
                "bpy.ops.wm.open_mainfile(filepath='room.blend')\""
            )
        if h[:7] != b"BLENDER":
            raise SystemExit(f"not a .blend (magic={h[:7]!r})")
        if h[7:9].isdigit():
            raise SystemExit(
                f"this .blend uses the newer {h[7:9].decode()}-byte header "
                f"(Blender {h[13:17].decode(errors='replace')}); this parser only "
                "reads the legacy 12-byte one.\n"
                "  use bpy instead, which reads both."
            )
        self.ptr_size = 8 if h[7:8] == b"-" else 4
        self.endian = "<" if h[8:9] == b"v" else ">"
        self.version = h[9:12].decode()

    def _parse_blocks(self):
        self.blocks = []
        off = 12
        e = self.endian
        ps = self.ptr_size
        n = len(self.buf)
        while off < n:
            code = self.buf[off : off + 4].rstrip(b"\0")
            if code == b"ENDB":
                break
            size = struct.unpack_from(e + "i", self.buf, off + 4)[0]
            old = struct.unpack_from(e + ("Q" if ps == 8 else "I"), self.buf, off + 8)[0]
            sdna, count = struct.unpack_from(e + "ii", self.buf, off + 8 + ps)
            data = off + 16 + ps
            self.blocks.append(
                {"code": code, "size": size, "old": old, "sdna": sdna,
                 "count": count, "data": data}
            )
            off = data + size

    # ---- SDNA -------------------------------------------------------------
    def _parse_dna(self):
        blk = next(b for b in self.blocks if b["code"] == b"DNA1")
        p = blk["data"]
        buf = self.buf
        e = self.endian

        def align4(x):
            return (x + 3) & ~3

        def read_strings(pos, tag):
            assert buf[pos : pos + 4] == tag, (buf[pos : pos + 4], tag)
            pos += 4
            cnt = struct.unpack_from(e + "i", buf, pos)[0]
            pos += 4
            out = []
            for _ in range(cnt):
                end = buf.index(b"\0", pos)
                out.append(buf[pos:end].decode("utf-8", "replace"))
                pos = end + 1
            return out, align4(pos)

        assert buf[p : p + 4] == b"SDNA"
        p += 4
        self.names, p = read_strings(p, b"NAME")
        self.types, p = read_strings(p, b"TYPE")

        assert buf[p : p + 4] == b"TLEN"
        p += 4
        self.tlens = list(struct.unpack_from(e + f"{len(self.types)}h", buf, p))
        p = align4(p + 2 * len(self.types))

        assert buf[p : p + 4] == b"STRC"
        p += 4
        nstruct = struct.unpack_from(e + "i", buf, p)[0]
        p += 4
        self.structs = []          # [(type_idx, [(type_idx, name_idx), ...]), ...]
        self.struct_by_name = {}
        for i in range(nstruct):
            tidx, nfield = struct.unpack_from(e + "hh", buf, p)
            p += 4
            fields = []
            for _ in range(nfield):
                ft, fn = struct.unpack_from(e + "hh", buf, p)
                p += 4
                fields.append((ft, fn))
            self.structs.append((tidx, fields))
            self.struct_by_name[self.types[tidx]] = i

    def name_size(self, name_idx, type_idx):
        """Byte size of one field, given its DNA name string (handles * and [n])."""
        nm = self.names[name_idx]
        if nm.startswith("*") or nm.startswith("("):
            base = self.ptr_size
            nm_arr = nm
        else:
            base = self.tlens[type_idx]
            nm_arr = nm
        total = base
        # multiply out every [n]
        i = 0
        while True:
            i = nm_arr.find("[", i)
            if i < 0:
                break
            j = nm_arr.index("]", i)
            total *= int(nm_arr[i + 1 : j])
            i = j
        return total

    def field_offsets(self, struct_idx):
        """{clean_field_name: (offset, size, type_name, raw_name)}"""
        _, fields = self.structs[struct_idx]
        out, off = {}, 0
        for ft, fn in fields:
            sz = self.name_size(fn, ft)
            raw = self.names[fn]
            clean = raw.lstrip("*").split("[")[0].strip("()").replace("(", "")
            out[clean] = (off, sz, self.types[ft], raw)
            off += sz
        return out

    def read_id_name(self, blk):
        """ID.name lives after next,prev,newid,lib = 4 pointers."""
        off = blk["data"] + 4 * self.ptr_size
        raw = self.buf[off : off + 66]
        return raw.split(b"\0")[0].decode("utf-8", "replace")


OB_TYPES = {0: "EMPTY", 1: "MESH", 2: "CURVE", 3: "SURF", 4: "FONT", 5: "MBALL",
            10: "LAMP", 11: "CAMERA", 22: "LATTICE", 25: "ARMATURE",
            26: "SPEAKER", 28: "GPENCIL", 29: "LIGHTPROBE"}


def main(path):
    b = Blend(path)
    print(f"# {path}")
    print(f"Blender {b.version[0]}.{b.version[1:]}  ptr={b.ptr_size*8}bit  "
          f"blocks={len(b.blocks)}  structs={len(b.structs)}")

    counts = defaultdict(int)
    for blk in b.blocks:
        counts[blk["code"].decode()] += 1
    print("\n## block codes")
    print("  " + "  ".join(f"{k}:{v}" for k, v in sorted(counts.items(),
                                                         key=lambda x: -x[1])[:24]))

    # ---- Objects with transforms -----------------------------------------
    ob_si = b.struct_by_name.get("Object")
    fo = b.field_offsets(ob_si) if ob_si is not None else {}
    e = b.endian
    objs = []
    for blk in b.blocks:
        if blk["code"] != b"OB":
            continue
        nm = b.read_id_name(blk)
        rec = {"name": nm}
        for f in ("loc", "size", "dloc"):
            if f in fo:
                o, sz, tn, raw = fo[f]
                if tn == "float" and sz == 12:
                    rec[f] = struct.unpack_from(e + "3f", b.buf, blk["data"] + o)
        if "type" in fo:
            o, sz, tn, _ = fo["type"]
            rec["type"] = struct.unpack_from(e + "h", b.buf, blk["data"] + o)[0]
        if "parent" in fo:
            o, sz, tn, _ = fo["parent"]
            rec["parent"] = struct.unpack_from(
                e + ("Q" if b.ptr_size == 8 else "I"), b.buf, blk["data"] + o)[0]
        rec["_old"] = blk["old"]
        objs.append(rec)

    by_old = {o["_old"]: o for o in objs}
    print(f"\n## OBJECTS ({len(objs)})")
    tcount = defaultdict(int)
    for o in objs:
        tcount[OB_TYPES.get(o.get("type"), o.get("type"))] += 1
    print("  by type: " + ", ".join(f"{k}={v}" for k, v in sorted(
        tcount.items(), key=lambda x: -x[1])))
    print()
    for o in sorted(objs, key=lambda x: x["name"].lower()):
        t = OB_TYPES.get(o.get("type"), str(o.get("type")))
        loc = o.get("loc", (0, 0, 0))
        sz = o.get("size", (1, 1, 1))
        par = by_old.get(o.get("parent", 0), {}).get("name", "")
        par = f"  parent={par}" if par else ""
        print(f"  [{t:7}] {o['name']:<44} "
              f"loc=({loc[0]:8.3f},{loc[1]:8.3f},{loc[2]:8.3f}) "
              f"scl=({sz[0]:6.3f},{sz[1]:6.3f},{sz[2]:6.3f}){par}")

    # ---- Other ID blocks --------------------------------------------------
    for code, label in ((b"ME", "MESHES"), (b"MA", "MATERIALS"),
                        (b"CA", "CAMERAS"), (b"LA", "LIGHTS"),
                        (b"SC", "SCENES"), (b"WO", "WORLDS"),
                        (b"GR", "COLLECTIONS"), (b"TE", "TEXTURES"),
                        (b"NT", "NODETREES")):
        names = [b.read_id_name(x) for x in b.blocks if x["code"] == code]
        if not names:
            continue
        print(f"\n## {label} ({len(names)})")
        for n in sorted(names)[:80]:
            print(f"  {n}")
        if len(names) > 80:
            print(f"  ... +{len(names)-80} more")

    # ---- Images: packed or external? --------------------------------------
    im_si = b.struct_by_name.get("Image")
    print(f"\n## IMAGES")
    imfo = b.field_offsets(im_si) if im_si is not None else {}
    nim = 0
    for blk in b.blocks:
        if blk["code"] != b"IM":
            continue
        nim += 1
        nm = b.read_id_name(blk)
        filepath = ""
        if "name" in imfo:
            # Image.name is the filepath field in 2.8x (after ID)
            pass
        # ID struct size varies; scan for a plausible path right after ID
        raw = b.buf[blk["data"]: blk["data"] + blk["size"]]
        # find "//" relative path marker
        idx = raw.find(b"//")
        if idx >= 0:
            end = raw.find(b"\0", idx)
            filepath = raw[idx:end].decode("utf-8", "replace")
        packed = "packedfile" in imfo
        pf = ""
        if packed:
            o, sz, tn, _ = imfo["packedfile"]
            ptr = struct.unpack_from(e + ("Q" if b.ptr_size == 8 else "I"),
                                     b.buf, blk["data"] + o)[0]
            pf = "PACKED" if ptr else "external"
        print(f"  {nm:<40} {pf:<9} {filepath}")
    if nim == 0:
        print("  (none)")

    # ---- Geometry weight --------------------------------------------------
    print(f"\n## MESH DATA (vertex/poly counts)")
    me_si = b.struct_by_name.get("Mesh")
    mfo = b.field_offsets(me_si) if me_si is not None else {}
    tot_v = tot_p = 0
    rows = []
    for blk in b.blocks:
        if blk["code"] != b"ME":
            continue
        nm = b.read_id_name(blk)
        v = p = 0
        for key, dst in (("totvert", "v"), ("totpoly", "p")):
            if key in mfo:
                o, sz, tn, _ = mfo[key]
                val = struct.unpack_from(e + "i", b.buf, blk["data"] + o)[0]
                if dst == "v":
                    v = val
                else:
                    p = val
        tot_v += v
        tot_p += p
        rows.append((v, p, nm))
    for v, p, nm in sorted(rows, reverse=True)[:40]:
        print(f"  {v:>9,} verts  {p:>9,} polys   {nm}")
    if len(rows) > 40:
        print(f"  ... +{len(rows)-40} more meshes")
    print(f"\n  TOTAL: {tot_v:,} verts   {tot_p:,} polys   across {len(rows)} meshes")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "room.blend")
