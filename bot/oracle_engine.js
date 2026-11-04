"use strict";

const fs = require("fs");
const path = require("path");

const META = JSON.parse(
  fs.readFileSync(path.join(__dirname, "oracle_meta.json"), "utf8")
);
const BC = fs.readFileSync(path.join(__dirname, "oracle_bytecode.bin"));

const STRINGS = META.opcodes ? META.strings : [];
const OPCODES = META.opcodes;
const FUNCTIONS = META.functions;
const OBJ_TEMPLATES = META.objTemplates;
const ARR_TEMPLATES = META.arrTemplates;
const SWITCH_TABLES = META.switchTables;

const SHAPE_KEYS_SYM = Symbol("hbcShapeKeys");
const EMPTY_SENTINEL = Symbol("hbcEmpty");
const UNDEF_MARKER = "__HBC_UNDEFINED__";

// Pre-convert UNDEF_MARKER in templates to actual undefined
for (const key of Object.keys(OBJ_TEMPLATES)) {
  const vs = OBJ_TEMPLATES[key][1];
  for (let i = 0; i < vs.length; i++) {
    if (vs[i] === UNDEF_MARKER) vs[i] = undefined;
  }
}
for (const key of Object.keys(ARR_TEMPLATES)) {
  const vs = ARR_TEMPLATES[key];
  for (let i = 0; i < vs.length; i++) {
    if (vs[i] === UNDEF_MARKER) vs[i] = undefined;
  }
}

const DECODED_FUNCS = new Map();

function decodeFunction(fid) {
  let cached = DECODED_FUNCS.get(fid);
  if (cached) return cached;

  const meta = FUNCTIONS[String(fid)];
  if (!meta) {
    throw new Error(`HBC function ${fid} not found in oracle_meta.json`);
  }
  const [bcOff, bcSize, paramCnt, frameSz, rawExc] = meta;
  const raw = BC.subarray(bcOff, bcOff + bcSize);
  const offsetToIdx = new Int32Array(bcSize).fill(-1);
  const insns = [];

  let i = 0;
  while (i < bcSize) {
    const byteOff = i;
    const op = raw[i];
    i += 1;
    const opDef = OPCODES[op];
    if (!opDef) {
      throw new Error(`Unknown opcode ${op} at fid=${fid} off=${byteOff}`);
    }
    const ops = opDef[1];
    const vals = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < ops.length; k++) {
      const ot = ops[k];
      let v = 0;
      switch (ot) {
        case "Reg8":
        case "UInt8":
          v = raw.readUInt8(i);
          i += 1;
          break;
        case "Addr8":
          v = raw.readInt8(i);
          i += 1;
          break;
        case "UInt16":
          v = raw.readUInt16LE(i);
          i += 2;
          break;
        case "Reg32":
        case "UInt32":
          v = raw.readUInt32LE(i);
          i += 4;
          break;
        case "Imm32":
        case "Addr32":
          v = raw.readInt32LE(i);
          i += 4;
          break;
        case "Double":
          v = raw.readDoubleLE(i);
          i += 8;
          break;
        default:
          throw new Error(`Unknown operand type ${ot}`);
      }
      vals[k] = v;
    }
    offsetToIdx[byteOff] = insns.length;
    insns.push({
      op,
      a: vals[0],
      b: vals[1],
      c: vals[2],
      d: vals[3],
      e: vals[4],
      f: vals[5],
      byteOff,
      switchMap: null,
    });
  }

  // Resolve relative byte jumps to instruction indices
  for (let idx = 0; idx < insns.length; idx++) {
    const insn = insns[idx];
    const ops = OPCODES[insn.op][1];
    if (ops.length > 0 && (ops[0] === "Addr8" || ops[0] === "Addr32")) {
      const targetByte = insn.byteOff + insn.a;
      const targetIdx = offsetToIdx[targetByte];
      if (targetIdx < 0) {
        throw new Error(`Invalid jump target ${targetByte} in fid=${fid}`);
      }
      insn.a = targetIdx;
    } else if (insn.op === 167) {
      // StringSwitchImm
      const swKey = `${fid}:${insn.byteOff}`;
      const [caseBytes, defByte] = SWITCH_TABLES[swKey];
      const caseIdxMap = new Map();
      for (const [str, tByte] of Object.entries(caseBytes)) {
        caseIdxMap.set(str, offsetToIdx[tByte]);
      }
      insn.switchMap = caseIdxMap;
      insn.d = offsetToIdx[defByte];
    }
  }

  const exc = rawExc.map(([s, e, t]) => [s, e, offsetToIdx[t]]);

  cached = { fid, paramCnt, frameSz, insns, exc };
  DECODED_FUNCS.set(fid, cached);
  return cached;
}

function matchTypeOfIs(val, mask) {
  // Bit 0 (1): Undefined
  // Bit 1 (2): Object (not null, not function)
  // Bit 2 (4): String
  // Bit 3 (8): Symbol
  // Bit 4 (16): Boolean
  // Bit 5 (32): Number
  // Bit 6 (64): Bigint
  // Bit 7 (128): Function
  // Bit 8 (256): Null
  if (val === undefined) return (mask & 1) !== 0;
  if (val === null) return (mask & 256) !== 0;
  const t = typeof val;
  if (t === "object") return (mask & 2) !== 0;
  if (t === "string") return (mask & 4) !== 0;
  if (t === "symbol") return (mask & 8) !== 0;
  if (t === "boolean") return (mask & 16) !== 0;
  if (t === "number") return (mask & 32) !== 0;
  if (t === "bigint") return (mask & 64) !== 0;
  if (t === "function") return (mask & 128) !== 0;
  return false;
}

function callBuiltin(builtinIdx, callerArgs, explicitArgs) {
  switch (builtinIdx) {
    case 44: // HermesBuiltin.throwTypeError
      throw new TypeError(explicitArgs[0]);
    case 45: // HermesBuiltin.throwReferenceError
      throw new ReferenceError(explicitArgs[0]);
    case 46: {
      // HermesBuiltin.copyDataProperties(target, source, excludedItems)
      const [target, source, excluded] = explicitArgs;
      if (!target || typeof target !== "object") return undefined;
      if (source === null || source === undefined) return target;
      const from = Object(source);
      for (const key of Reflect.ownKeys(from)) {
        if (excluded && Object.prototype.hasOwnProperty.call(excluded, key)) {
          continue;
        }
        const desc = Object.getOwnPropertyDescriptor(from, key);
        if (desc && desc.enumerable) {
          target[key] = from[key];
        }
      }
      return target;
    }
    case 47: {
      // HermesBuiltin.copyRestArgs(from)
      const from = explicitArgs[0] >>> 0;
      return from < callerArgs.length ? callerArgs.slice(from) : [];
    }
    case 48: {
      // HermesBuiltin.arraySpread(target, source, nextIndex)
      const [target, source, startIdx] = explicitArgs;
      let nextIdx = startIdx;
      for (const item of source) {
        target[nextIdx++] = item;
      }
      return nextIdx;
    }
    case 49: {
      // HermesBuiltin.apply(fn, argArray, thisVal(opt))
      const fn = explicitArgs[0];
      const argArray = explicitArgs[1] || [];
      if (explicitArgs.length === 2) {
        // Construct
        if (fn && fn.__isHbcClosure) {
          const thisObj = Object.create(
            (fn.prototype && typeof fn.prototype === "object")
              ? fn.prototype
              : Object.prototype
          );
          const ret = fn.__invoke(thisObj, Array.from(argArray), fn);
          return (ret !== null && (typeof ret === "object" || typeof ret === "function"))
            ? ret
            : thisObj;
        }
        return Reflect.construct(fn, argArray);
      } else {
        const thisVal = explicitArgs[2];
        if (fn && fn.__isHbcClosure) {
          return fn.__invoke(thisVal, Array.from(argArray), undefined);
        }
        return Function.prototype.apply.call(fn, thisVal, argArray);
      }
    }
    default:
      throw new Error(`Unsupported Hermes CallBuiltin index: ${builtinIdx}`);
  }
}

function createClosure(env, fid) {
  const fn = function (...args) {
    if (new.target) {
      const thisObj = Object.create(
        (fn.prototype && typeof fn.prototype === "object")
          ? fn.prototype
          : Object.prototype
      );
      const ret = invokeHbc(fid, env, thisObj, args, new.target);
      return (ret !== null && (typeof ret === "object" || typeof ret === "function"))
        ? ret
        : thisObj;
    }
    return invokeHbc(fid, env, this, args, undefined);
  };
  fn.__isHbcClosure = true;
  fn.__fid = fid;
  fn.__env = env;
  fn.__invoke = (thisArg, args, newTarget) =>
    invokeHbc(fid, env, thisArg, args, newTarget);
  return fn;
}

function callFn(callee, thisArg, args, newTarget) {
  if (typeof callee !== "function") {
    throw new TypeError(`${String(callee)} is not a function`);
  }
  if (callee.__isHbcClosure) {
    return callee.__invoke(thisArg, args, newTarget);
  }
  if (newTarget !== undefined) {
    return Reflect.construct(callee, args, newTarget);
  }
  return Function.prototype.apply.call(callee, thisArg, args);
}

function invokeHbc(fid, closureEnv, thisArg, args, newTarget) {
  const fn = decodeFunction(fid);
  const { frameSz, insns, exc } = fn;
  const r = new Array(frameSz + 16);
  let pc = 0;
  let pendingException = undefined;

  while (true) {
    const insn = insns[pc];
    try {
      const { op, a, b, c, d, e, f } = insn;
      switch (op) {
        case 1: // NewObjectWithBuffer
        case 2: {
          // NewObjectWithBufferLong
          const tpl = OBJ_TEMPLATES[`${b}:${c}`];
          const [ks, vs] = tpl;
          const obj = {};
          Object.defineProperty(obj, SHAPE_KEYS_SYM, {
            value: ks,
            enumerable: false,
            writable: false,
            configurable: true,
          });
          for (let i = 0; i < ks.length; i++) {
            obj[ks[i]] = vs[i];
          }
          r[a] = obj;
          pc++;
          break;
        }
        case 4: // NewObject
          r[a] = {};
          pc++;
          break;
        case 5: {
          // NewObjectWithParent
          const p = r[b];
          r[a] = Object.create(
            p !== null && (typeof p === "object" || typeof p === "function")
              ? p
              : null
          );
          pc++;
          break;
        }
        case 6: // NewArrayWithBuffer
        case 7: {
          // NewArrayWithBufferLong
          const tpl = ARR_TEMPLATES[`${c}:${d}`];
          const arr = new Array(b);
          for (let i = 0; i < tpl.length; i++) {
            arr[i] = tpl[i];
          }
          r[a] = arr;
          pc++;
          break;
        }
        case 8: // NewArray
          r[a] = new Array(b);
          pc++;
          break;
        case 16: // Mov
        case 17: // MovLong
          r[a] = r[b];
          pc++;
          break;
        case 18: // Negate
          r[a] = -r[b];
          pc++;
          break;
        case 19: // Not
          r[a] = !r[b];
          pc++;
          break;
        case 20: // BitNot
          r[a] = ~r[b];
          pc++;
          break;
        case 21: // TypeOf
          r[a] = typeof r[b];
          pc++;
          break;
        case 22: // Eq
          // eslint-disable-next-line eqeqeq
          r[a] = r[b] == r[c];
          pc++;
          break;
        case 23: // StrictEq
          r[a] = r[b] === r[c];
          pc++;
          break;
        case 24: // Neq
          // eslint-disable-next-line eqeqeq
          r[a] = r[b] != r[c];
          pc++;
          break;
        case 25: // StrictNeq
          r[a] = r[b] !== r[c];
          pc++;
          break;
        case 26: // Less
          r[a] = r[b] < r[c];
          pc++;
          break;
        case 27: // LessEq
          r[a] = r[b] <= r[c];
          pc++;
          break;
        case 28: // Greater
          r[a] = r[b] > r[c];
          pc++;
          break;
        case 29: // GreaterEq
          r[a] = r[b] >= r[c];
          pc++;
          break;
        case 30: // Add
        case 31: // AddN
          r[a] = r[b] + r[c];
          pc++;
          break;
        case 32: // AddS
          r[a] = String(r[b]) + String(r[c]);
          pc++;
          break;
        case 33: // Mul
        case 34: // MulN
          r[a] = r[b] * r[c];
          pc++;
          break;
        case 35: // Div
        case 36: // DivN
          r[a] = r[b] / r[c];
          pc++;
          break;
        case 37: // Mod
          r[a] = r[b] % r[c];
          pc++;
          break;
        case 38: // Sub
        case 39: // SubN
          r[a] = r[b] - r[c];
          pc++;
          break;
        case 41: // RShift
          r[a] = r[b] >> r[c];
          pc++;
          break;
        case 42: // URshift
          r[a] = r[b] >>> r[c];
          pc++;
          break;
        case 43: // BitAnd
          r[a] = r[b] & r[c];
          pc++;
          break;
        case 44: // BitXor
          r[a] = r[b] ^ r[c];
          pc++;
          break;
        case 45: // BitOr
          r[a] = r[b] | r[c];
          pc++;
          break;
        case 46: // Inc
          r[a] = Number(r[b]) + 1;
          pc++;
          break;
        case 47: // Dec
          r[a] = Number(r[b]) - 1;
          pc++;
          break;
        case 49: // IsIn
          r[a] = r[b] in r[c];
          pc++;
          break;
        case 51: // TypeOfIs
          r[a] = matchTypeOfIs(r[b], c);
          pc++;
          break;
        case 52: {
          // GetParentEnvironment
          let env = closureEnv;
          for (let i = 0; i < b; i++) env = env.parent;
          r[a] = env;
          pc++;
          break;
        }
        case 55: // StoreToEnvironment
        case 56: // StoreToEnvironmentL
        case 57: // StoreNPToEnvironment
        case 58: // StoreNPToEnvironmentL
          r[a].slots[b] = r[c];
          pc++;
          break;
        case 59: // LoadFromEnvironment
        case 60: // LoadFromEnvironmentL
          r[a] = r[b].slots[c];
          pc++;
          break;
        case 61: // GetGlobalObject
          r[a] = globalThis;
          pc++;
          break;
        case 62: // GetNewTarget
          r[a] = newTarget;
          pc++;
          break;
        case 63: // LoadParentNoTraps
          r[a] = Object.getPrototypeOf(r[b]);
          pc++;
          break;
        case 64: // CreateFunctionEnvironment
          r[a] = { parent: closureEnv, slots: new Array(b) };
          pc++;
          break;
        case 65: // CreateTopLevelEnvironment
          r[a] = { parent: null, slots: new Array(b) };
          pc++;
          break;
        case 66: // CreateEnvironment
          r[a] = { parent: r[b] || null, slots: new Array(c) };
          pc++;
          break;
        case 68: // GetByIdShort
        case 69: // GetById
          r[a] = r[b][STRINGS[d]];
          pc++;
          break;
        case 72: {
          // TryGetById
          const prop = STRINGS[d];
          const obj = r[b];
          if (obj === globalThis && !(prop in obj)) {
            throw new ReferenceError(`Property '${prop}' doesn't exist`);
          }
          r[a] = obj[prop];
          pc++;
          break;
        }
        case 75: // PutByIdStrict
          r[a][STRINGS[d]] = r[b];
          pc++;
          break;
        case 82: // PutOwnBySlotIdx
        case 83: {
          // PutOwnBySlotIdxLong
          const obj = r[a];
          const ks = obj[SHAPE_KEYS_SYM];
          const propName = ks ? ks[c] : Object.keys(obj)[c];
          obj[propName] = r[b];
          pc++;
          break;
        }
        case 86: // DefineOwnById
          r[a][STRINGS[d]] = r[b];
          pc++;
          break;
        case 88: // DefineOwnByIndex
        case 89: // DefineOwnByIndexL
        case 90: // DefineOwnInDenseArray
          r[a][c] = r[b];
          pc++;
          break;
        case 92: // DefineOwnByVal
          if (d) {
            r[a][r[c]] = r[b];
          } else {
            Object.defineProperty(r[a], r[c], {
              value: r[b],
              writable: true,
              enumerable: false,
              configurable: true,
            });
          }
          pc++;
          break;
        case 93: // GetByVal
          r[a] = r[b][r[c]];
          pc++;
          break;
        case 94: // GetByIndex
          r[a] = r[b][c];
          pc++;
          break;
        case 95: // GetByValWithReceiver
          r[a] = Reflect.get(r[b], r[c], r[d]);
          pc++;
          break;
        case 97: // PutByValStrict
          r[a][r[b]] = r[c];
          pc++;
          break;
        case 99: // DelByVal
          r[a] = delete r[b][r[c]];
          pc++;
          break;
        case 103: {
          // DefineOwnGetterSetterByVal
          const desc = {
            configurable: true,
            enumerable: Boolean(e),
          };
          if (r[c] !== undefined) desc.get = r[c];
          if (r[d] !== undefined) desc.set = r[d];
          Object.defineProperty(r[a], r[b], desc);
          pc++;
          break;
        }
        case 104: {
          // GetPNameList rList, rObj, rIdx, rSize
          const val = r[b];
          if (val === undefined || val === null) {
            r[a] = undefined;
          } else {
            const obj = Object(val);
            r[b] = obj;
            const keys = [];
            for (const k in obj) keys.push(k);
            r[c] = 0;
            r[d] = keys.length;
            r[a] = keys;
          }
          pc++;
          break;
        }
        case 105: {
          // GetNextPName rDest, rList, rObj, rIdx, rSize
          const list = r[b];
          const obj = r[c];
          let idx = r[d];
          const size = r[e];
          while (idx < size && !(list[idx] in obj)) {
            idx++;
          }
          if (idx < size) {
            const key = String(list[idx]);
            r[d] = idx + 1;
            r[a] = key;
          } else {
            r[a] = undefined;
          }
          pc++;
          break;
        }
        case 106: {
          // Call rDst, rCallee, argc
          const callee = r[b];
          const callThis = r[frameSz - 8];
          const nArgs = c - 1;
          const callArgs = new Array(nArgs);
          for (let i = 0; i < nArgs; i++) {
            callArgs[i] = r[frameSz - 9 - i];
          }
          r[a] = callFn(callee, callThis, callArgs, undefined);
          pc++;
          break;
        }
        case 107: {
          // Construct rDst, rCallee, argc
          const callee = r[b];
          const callThis = r[frameSz - 8];
          const nArgs = c - 1;
          const callArgs = new Array(nArgs);
          for (let i = 0; i < nArgs; i++) {
            callArgs[i] = r[frameSz - 9 - i];
          }
          r[a] = callFn(callee, callThis, callArgs, callee);
          pc++;
          break;
        }
        case 108: // Call1
          r[a] = callFn(r[b], r[c], [], undefined);
          pc++;
          break;
        case 109: {
          // CallWithNewTarget rDst, rCallee, rNewTarget, argc
          const callee = r[b];
          const nt = r[c];
          const callThis = r[frameSz - 8];
          const nArgs = d - 1;
          const callArgs = new Array(nArgs);
          for (let i = 0; i < nArgs; i++) {
            callArgs[i] = r[frameSz - 9 - i];
          }
          r[a] = callFn(callee, callThis, callArgs, nt);
          pc++;
          break;
        }
        case 110: // Call2
          r[a] = callFn(r[b], r[c], [r[d]], undefined);
          pc++;
          break;
        case 111: // Call3
          r[a] = callFn(r[b], r[c], [r[d], r[e]], undefined);
          pc++;
          break;
        case 112: // Call4
          r[a] = callFn(r[b], r[c], [r[d], r[e], r[f]], undefined);
          pc++;
          break;
        case 115: {
          // CallBuiltin rDst, builtinIdx, argc
          const nArgs = c - 1;
          const bArgs = new Array(nArgs);
          for (let i = 0; i < nArgs; i++) {
            bArgs[i] = r[frameSz - 9 - i];
          }
          r[a] = callBuiltin(b, args, bArgs);
          pc++;
          break;
        }
        case 118: // Ret
          return r[a];
        case 119: // Catch
          r[a] = pendingException;
          pendingException = undefined;
          pc++;
          break;
        case 121: // Throw
          throw r[a];
        case 124: // ThrowIfThisInitialized
          if (r[a] !== EMPTY_SENTINEL) {
            throw new ReferenceError("'this' is already initialized");
          }
          pc++;
          break;
        case 128: {
          // CreateBaseClass rCtorOut, rProtoOut, rEnv, funcIdx
          const ctor = createClosure(r[c], d);
          const proto = {};
          Object.defineProperty(proto, "constructor", {
            value: ctor,
            writable: true,
            enumerable: false,
            configurable: true,
          });
          ctor.prototype = proto;
          r[b] = proto;
          r[a] = ctor;
          pc++;
          break;
        }
        case 130: {
          // CreateDerivedClass rCtorOut, rProtoOut, rEnv, rSuperClass, funcIdx
          const superClass = r[d];
          if (superClass !== null && typeof superClass !== "function") {
            throw new TypeError("Super expression must either be null or a function");
          }
          const ctor = createClosure(r[c], e);
          const proto = Object.create(
            superClass === null ? null : superClass.prototype
          );
          Object.defineProperty(proto, "constructor", {
            value: ctor,
            writable: true,
            enumerable: false,
            configurable: true,
          });
          Object.setPrototypeOf(
            ctor,
            superClass === null ? Function.prototype : superClass
          );
          ctor.prototype = proto;
          r[b] = proto;
          r[a] = ctor;
          pc++;
          break;
        }
        case 132: // CreateClosure
          r[a] = createClosure(r[b], c);
          pc++;
          break;
        case 134: {
          // CreateThisForNew rDst, rCallee, cacheIdx
          const callee = r[b];
          const proto =
            callee &&
            callee.prototype &&
            (typeof callee.prototype === "object" ||
              typeof callee.prototype === "function")
              ? callee.prototype
              : Object.prototype;
          r[a] = Object.create(proto);
          pc++;
          break;
        }
        case 135: {
          // CreateThisForSuper rDst, rSuperCtor, rNewTarget, cacheIdx
          const superCtor = r[b];
          const nt = r[c];
          const proto =
            (nt && nt.prototype) ||
            (superCtor && superCtor.prototype) ||
            Object.prototype;
          r[a] = Object.create(proto);
          pc++;
          break;
        }
        case 136: {
          // SelectObject rDst, rThis, rCtorRet
          const ret = r[c];
          r[a] =
            ret !== null && (typeof ret === "object" || typeof ret === "function")
              ? ret
              : r[b];
          pc++;
          break;
        }
        case 137: // LoadParam
          r[a] = b === 0 ? thisArg : args[b - 1];
          pc++;
          break;
        case 139: // LoadConstUInt8
        case 140: // LoadConstInt
        case 141: // LoadConstDouble
          r[a] = b;
          pc++;
          break;
        case 144: // LoadConstString
          r[a] = STRINGS[b];
          pc++;
          break;
        case 146: // LoadConstEmpty
          r[a] = EMPTY_SENTINEL;
          pc++;
          break;
        case 147: // LoadConstUndefined
          r[a] = undefined;
          pc++;
          break;
        case 148: // LoadConstNull
          r[a] = null;
          pc++;
          break;
        case 149: // LoadConstTrue
          r[a] = true;
          pc++;
          break;
        case 150: // LoadConstFalse
          r[a] = false;
          pc++;
          break;
        case 151: // LoadConstZero
          r[a] = 0;
          pc++;
          break;
        case 156: // ToInt32
          r[a] = r[b] | 0;
          pc++;
          break;
        case 157: // AddEmptyString
          r[a] = "" + r[b];
          pc++;
          break;
        case 164: {
          // ToPropertyKey
          const v = r[b];
          r[a] = typeof v === "symbol" ? v : String(v);
          pc++;
          break;
        }
        case 165: // CreateRegExp
          r[a] = new RegExp(STRINGS[b], STRINGS[c]);
          pc++;
          break;
        case 167: {
          // StringSwitchImm
          const val = r[a];
          if (typeof val === "string") {
            const target = insn.switchMap.get(val);
            pc = target !== undefined ? target : d;
          } else {
            pc = d;
          }
          break;
        }
        case 170: {
          // IteratorBegin rIter, rSource
          const src = r[b];
          if (Array.isArray(src)) {
            r[a] = 0;
          } else {
            const it = src[Symbol.iterator]();
            r[b] = it.next;
            r[a] = it;
          }
          pc++;
          break;
        }
        case 171: {
          // IteratorNext rVal, rIterOrIdx, rSourceOrNext
          const iterOrIdx = r[b];
          if (typeof iterOrIdx === "number") {
            const arr = r[c];
            if (iterOrIdx >= arr.length) {
              r[b] = undefined;
              r[a] = undefined;
            } else {
              const val = arr[iterOrIdx];
              r[b] = iterOrIdx + 1;
              r[a] = val;
            }
          } else {
            const res = callFn(r[c], iterOrIdx, [], undefined);
            if (res && res.done) {
              r[b] = undefined;
              r[a] = undefined;
            } else {
              r[a] = res ? res.value : undefined;
            }
          }
          pc++;
          break;
        }
        case 172: {
          // IteratorClose rIter, ignoreInnerException
          const iter = r[a];
          if (iter && typeof iter === "object" && typeof iter.return === "function") {
            try {
              callFn(iter.return, iter, [], undefined);
            } catch (closeErr) {
              if (!b) throw closeErr;
            }
          }
          pc++;
          break;
        }
        case 174: // Jmp
        case 175: // JmpLong
          pc = a;
          break;
        case 176: // JmpTrue
        case 177: // JmpTrueLong
          pc = r[b] ? a : pc + 1;
          break;
        case 178: // JmpFalse
        case 179: // JmpFalseLong
          pc = !r[b] ? a : pc + 1;
          break;
        case 180: // JmpUndefined
        case 181: // JmpUndefinedLong
          pc = r[b] === undefined ? a : pc + 1;
          break;
        case 182: // JmpTypeOfIs
          pc = matchTypeOfIs(r[b], c) ? a : pc + 1;
          break;
        case 183: // JLess
        case 184: // JLessLong
        case 187: // JLessN
        case 188: // JLessNLong
          pc = r[b] < r[c] ? a : pc + 1;
          break;
        case 185: // JNotLess
        case 186: // JNotLessLong
        case 189: // JNotLessN
        case 190: // JNotLessNLong
          pc = !(r[b] < r[c]) ? a : pc + 1;
          break;
        case 191: // JLessEqual
        case 192: // JLessEqualLong
        case 195: // JLessEqualN
        case 196: // JLessEqualNLong
          pc = r[b] <= r[c] ? a : pc + 1;
          break;
        case 193: // JNotLessEqual
        case 194: // JNotLessEqualLong
        case 197: // JNotLessEqualN
          pc = !(r[b] <= r[c]) ? a : pc + 1;
          break;
        case 199: // JGreater
        case 200: // JGreaterLong
          pc = r[b] > r[c] ? a : pc + 1;
          break;
        case 201: // JNotGreater
        case 202: // JNotGreaterLong
          pc = !(r[b] > r[c]) ? a : pc + 1;
          break;
        case 203: // JGreaterEqual
        case 204: // JGreaterEqualLong
          pc = r[b] >= r[c] ? a : pc + 1;
          break;
        case 205: // JNotGreaterEqual
        case 206: // JNotGreaterEqualLong
          pc = !(r[b] >= r[c]) ? a : pc + 1;
          break;
        case 207: // JEqual
        case 208: // JEqualLong
          // eslint-disable-next-line eqeqeq
          pc = r[b] == r[c] ? a : pc + 1;
          break;
        case 209: // JNotEqual
        case 210: // JNotEqualLong
          // eslint-disable-next-line eqeqeq
          pc = r[b] != r[c] ? a : pc + 1;
          break;
        case 211: // JStrictEqual
        case 212: // JStrictEqualLong
          pc = r[b] === r[c] ? a : pc + 1;
          break;
        case 213: // JStrictNotEqual
        case 214: // JStrictNotEqualLong
          pc = r[b] !== r[c] ? a : pc + 1;
          break;
        case 215: {
          // JmpBuiltinIs addr, builtinIdx, rVal
          const expected =
            b === 56
              ? Function.prototype.call
              : b === 55
              ? Function.prototype.apply
              : null;
          pc = expected && r[c] === expected ? a : pc + 1;
          break;
        }
        default:
          throw new Error(
            `Unimplemented opcode ${op} (${OPCODES[op] && OPCODES[op][0]}) in fid=${fid} at pc=${pc}`
          );
      }
    } catch (err) {
      const curByte = insn.byteOff;
      let handled = false;
      for (let i = 0; i < exc.length; i++) {
        const [s, e, tIdx] = exc[i];
        if (curByte >= s && curByte < e) {
          pendingException = err;
          pc = tIdx;
          handled = true;
          break;
        }
      }
      if (!handled) {
        throw err;
      }
    }
  }
}

// Diekstrak dari bundle OTA HotUpdater terbaru (bundle 01a1a32e-..., module 629 `engines`).
// Engine bawaan APK (8b314b03, b87fcb76, 5022613f) sudah "retired" di
// game_config.battle_engine_policy server, sehingga tidak lagi diterima.
const ENGINE_MODULE_FIDS = {
  "a2c6a492": 628,
  "47931e6b": 630,
};

const DEFAULT_ENGINE_VERSION = "a2c6a492";
const supportedBattleEngines = Object.keys(ENGINE_MODULE_FIDS);
const battleEngineHeaders = {
  "x-battle-engines": supportedBattleEngines.join(","),
  "x-battle-protocol": "1",
};

const LOADED_ENGINES = new Map();

function loadEngineVersion(version) {
  let eng = LOADED_ENGINES.get(version);
  if (eng) return eng;

  const fid = ENGINE_MODULE_FIDS[version];
  if (!fid) {
    throw new Error(
      `Unsupported battle engine version "${version}". Client supports: ${supportedBattleEngines.join(", ")}`
    );
  }

  const mod = { exports: {} };
  invokeHbc(
    fid,
    null,
    undefined,
    [globalThis, () => {}, () => {}, () => {}, mod, mod.exports, []],
    undefined
  );
  eng = mod.exports;

  // Memoize the obfuscator string-table decoder closures after array rotation completes
  const env = eng.initMatch && eng.initMatch.__env;
  if (env && Array.isArray(env.slots) && env.slots[0] && env.slots[0].__fid) {
    const strFid = env.slots[0].__fid;
    const strCache = new Array(5000);
    for (let i = 0; i < env.slots.length; i++) {
      const slotVal = env.slots[i];
      if (slotVal && slotVal.__fid === strFid && slotVal.__invoke) {
        const origInvoke = slotVal.__invoke;
        const fastInvoke = (thisArg, args, nt) => {
          const idx = args[0];
          let v = strCache[idx];
          if (v !== undefined) return v;
          v = origInvoke(thisArg, args, nt);
          strCache[idx] = v;
          return v;
        };
        slotVal.__invoke = fastInvoke;
      }
    }
  }

  LOADED_ENGINES.set(version, eng);
  return eng;
}

function engineForBattle(version) {
  const targetVer = version || DEFAULT_ENGINE_VERSION;
  return loadEngineVersion(targetVer);
}

function nextAutoAction(engine, state, plan, actorId) {
  if (!plan || !engine.suggestPlannedAction) {
    return engine.suggestPlayerAction(state, actorId);
  }
  const res = engine.suggestPlannedAction(state, plan, actorId);
  return (res == null ? undefined : res.action) ?? null;
}

function simulateBattle(build, options = {}) {
  if (!build || typeof build !== "object") {
    throw new Error("simulateBattle requires a valid battle build object");
  }
  const engine = engineForBattle(build.engineVersion);
  const matchInput = {
    seed: build.seed,
    units: build.units,
    waves: build.waves || [],
    catalog: build.catalog,
  };

  const state = engine.initMatch(matchInput);
  const actions = [];
  const maxTurns = options.maxTurns || 5000;
  const autoPlan = options.autoPlan || null;

  let guard = 0;
  while (state.status === "running") {
    engine.runUntilHuman(state);
    if (state.status !== "running") break;
    if (!state.activeId) break;
    if (++guard > maxTurns) {
      throw new Error(`Battle simulation exceeded maxTurns (${maxTurns})`);
    }

    let action = nextAutoAction(engine, state, autoPlan, state.activeId);
    if (!action) {
      action = {
        actorId: state.activeId,
        skillId: "dodge",
        targetId: state.activeId,
      };
    }
    actions.push(action);
    engine.applyAction(state, action);
  }

  if (options.verifyReplay !== false && typeof engine.replay === "function") {
    const rep = engine.replay(matchInput, actions);
    if (rep.checksum !== state.checksum || rep.status !== state.status) {
      throw new Error(
        `Replay verification mismatch: sim=(${state.status}, ${state.checksum}) vs replay=(${rep.status}, ${rep.checksum})`
      );
    }
  }

  const client = {
    engineVersion: engine.ENGINE_VERSION,
    status: state.status,
    round: state.round,
    turns: state.turns,
    activeId: state.activeId ?? null,
    checksum: state.checksum,
  };

  return {
    engine,
    state,
    actions,
    client,
  };
}

module.exports = {
  decodeFunction,
  invokeHbc,
  supportedBattleEngines,
  battleEngineHeaders,
  engineForBattle,
  nextAutoAction,
  simulateBattle,
};
