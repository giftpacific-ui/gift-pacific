# Generates the image files used by tests/e2e/admin.mjs and product.mjs into /tmp/e2efiles.
import os, struct, zlib
os.makedirs("/tmp/e2efiles", exist_ok=True); os.chdir("/tmp/e2efiles")
def png(w=200,h=200):
    def ch(t,d): c=struct.pack(">I",len(d))+t+d; return c+struct.pack(">I",zlib.crc32(t+d)&0xffffffff)
    raw=b"".join(b"\x00"+b"".join(bytes([x*255//w,y*255//h,128]) for x in range(w)) for y in range(h))
    return b"\x89PNG\r\n\x1a\n"+ch(b"IHDR",struct.pack(">IIBBBBB",w,h,8,2,0,0,0))+ch(b"IDAT",zlib.compress(raw))+ch(b"IEND",b"")
open("small.png","wb").write(png()); H=b"\x89PNG\r\n\x1a\n"
open("large12.png","wb").write(H+os.urandom(12*1024*1024)); open("huge45.png","wb").write(H+os.urandom(45*1024*1024))
open("photo.jpg","wb").write(b"\xff\xd8\xff\xe0"+os.urandom(200000)); open("photo.webp","wb").write(b"RIFF"+struct.pack("<I",4000)+b"WEBP"+os.urandom(4000))
open("spoof.png","wb").write(b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"); open("anim.gif","wb").write(b"GIF89a"+os.urandom(500))
