import test from 'node:test';
import assert from 'node:assert/strict';
import {listenErrorMessages} from '../listen-error.mjs';

test('port conflict points to the existing local workspace', () => {
  assert.deepEqual(
    listenErrorMessages({code: 'EADDRINUSE'}, 4318, 'http://127.0.0.1:4318'),
    [
      '端口 4318 已被占用。票夹可能已经在运行，请先打开：http://127.0.0.1:4318',
      '如果该地址无法访问，请关闭占用此端口的程序后再启动。',
    ],
  );
});

test('other startup errors retain their useful message', () => {
  assert.deepEqual(listenErrorMessages({message: 'permission denied'}, 4318, ''), ['本机票夹启动失败：permission denied']);
});
