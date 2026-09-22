import re,struct,sys,json
from collections import Counter
import os
D=os.environ.get('GECOM_DIR','/mnt/user-data/uploads/gecom/nova2026/')
def load_dict():
    b=open(D+'zdtablacampo.dat','rb').read()
    offs=[m.start() for m in re.finditer(rb'@\[[A-Z0-9]', b)]
    tables={}
    for o in offs:
        r=b[o:o+96]
        t=r[2:22].decode('latin1').strip(); seq=r[22:28].decode('latin1')
        n=r[28:58].decode('latin1').strip(); typ=r[88]; ln=r[90]; dec=r[91]
        tables.setdefault(t,{}).setdefault(seq[:3],[]).append((n,typ,ln,dec))
    return tables
def bcd(bs,dec):
    h=bs.hex()
    if not h: return None
    sign=-1 if h[-1] in 'dD' else 1
    digits=h[:-1] if h[-1] in 'cdfCDF' else h
    if not digits.isdigit(): return None
    return sign*int(digits)/(10**dec)
def decode(fields,rec):
    out={}; p=0
    for n,typ,ln,dec in fields:
        raw=rec[p:p+ln]; p+=ln
        if typ==0: v=raw.decode('latin1').rstrip()
        elif typ==1: v=raw.decode('latin1')
        elif typ==2: v=int.from_bytes(raw,'big')
        elif typ==3: v=bcd(raw,dec)
        elif typ==5: v=int.from_bytes(raw,'big')
        else: v=raw.hex()
        out[n]=v
    return out
def read_table(fname,fields,stride=None):
    b=open(D+fname,'rb').read()
    rl=struct.unpack('>H',b[0x38:0x3a])[0]
    start=0x84+rl-1  # '@' status marker position? we locate first '@' near
    # find first record: first byte >=0x80 status after prefix char
    i=0x84
    while i<len(b) and b[i]==0: i+=1
    start=i  # points to prefix char ('@' or letter)
    if stride is None:
        stride=((rl+10+7)//8)*8
    recs=[]
    p=start
    while p+2+rl<=len(b):
        status=b[p+1]
        rec=b[p+2:p+2+rl]
        recs.append((p,b[p],status,decode(fields,rec)))
        p+=stride
    return recs,rl,stride
if __name__=='__main__':
    T=load_dict()
    fields=T['CUENTA']['001']
    recs,rl,stride=read_table('cuenta.fac',fields,168)
    print(len(recs),rl,stride, Counter((r[2],r[3]['TIPOREGISTRO']) for r in recs).most_common(10))
    tot=0
    for p,pre,st,r in recs:
        if r['CODIGOAGENDA']=='00000139':
            print(chr(pre),hex(st),r['CODIGOPUNTO'],r['CODIGOCPTE'],r['LETRACPTE'],r['NUMEROCPTE'],r['FECHA'],r['VENCIMIENTO'],r['IMPORTE'],r['IMPCANCELADO'],r['CODIGOMONEDA'],r['MONEDAIMPORTE'],r['MONEDACANCELADO'],r['TIPOREGISTRO'])
            if r['IMPORTE'] is not None: tot+=r['IMPORTE']-(r['IMPCANCELADO'] or 0)
    print('saldo 139', round(tot,2))
