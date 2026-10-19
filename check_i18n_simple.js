const fs = require('fs');
const path = require('path');

const localesDir = path.join(__dirname, 'client/src/i18n/locales');

// 读取英文作为参考
const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));

// 递归获取所有键路径
function getAllKeys(obj, prefix = '') {
  const keys = [];
  for (const key in obj) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      keys.push(...getAllKeys(obj[key], newKey));
    } else {
      keys.push(newKey);
    }
  }
  return keys;
}

// 递归获取嵌套值
function getNestedValue(obj, path) {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

const enKeys = getAllKeys(en.messages).sort();

// 检查**全部**语言包（此前只查 ja.json，其余语言的缺键不会被拦住）
const files = fs.readdirSync(localesDir).filter((name) => name.endsWith('.json'));
let totalMissing = 0;

for (const file of files) {
  if (file === 'en.json') continue;
  const filePath = path.join(localesDir, file);
  const lang = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const missingKeys = [];

  for (const key of enKeys) {
    const value = getNestedValue(lang.messages, key);
    if (value === undefined) {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length > 0) {
    totalMissing += missingKeys.length;
    console.log(`${file} missing ${missingKeys.length} keys:`);
    missingKeys.slice(0, 50).forEach((key) => {
      const enValue = getNestedValue(en.messages, key);
      console.log(`${key}=${enValue}`);
    });
    if (missingKeys.length > 50) console.log(`... and ${missingKeys.length - 50} more`);
  } else {
    console.log(`${file} is complete!`);
  }
}

if (totalMissing > 0) {
  console.log(`\nTOTAL MISSING: ${totalMissing}`);
  process.exit(1);
}
console.log('All locales complete.');
