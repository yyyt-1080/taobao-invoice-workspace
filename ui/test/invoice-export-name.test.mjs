import test from 'node:test';
import assert from 'node:assert/strict';
import {invoiceProjectName} from '../invoice-export-name.mjs';

test('uses only the first invoice detail row when OCR returns multiple items', () => {
  const text = '项目名称 规格型号 单位 数量\n第一项商品  A1 件 1\n第二项商品 B2 件 2\n价税合计 30.00';
  assert.equal(invoiceProjectName(text), '第一项商品');
});

test('reads the first project when it appears on the label line', () => {
  const text = '项目名称：第一项商品 规格型号 A1\n第二项商品 规格型号 B2';
  assert.equal(invoiceProjectName(text), '第一项商品');
});

test('returns empty text if no project name can be identified', () => {
  assert.equal(invoiceProjectName('价税合计 30.00'), '');
});
