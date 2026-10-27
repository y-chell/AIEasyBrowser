import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { writeNodePathFile } from './utils';

const distDir = path.resolve(__dirname, '..', '..', 'dist');
// 清理上次构建
console.log('清理上次构建...');
try {
  // Chrome may use dist as the host's working directory; keep the directory itself.
  fs.mkdirSync(distDir, { recursive: true });
  for (const entry of fs.readdirSync(distDir)) {
    fs.rmSync(path.join(distDir, entry), { recursive: true, force: true });
  }
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`无法清理旧的构建产物 (${distDir}): ${message}`);
}

// 创建dist目录
fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(path.join(distDir, 'logs'), { recursive: true }); // 创建logs目录
console.log('dist 和 dist/logs 目录已创建/确认存在');

// 编译TypeScript
console.log('编译TypeScript...');
execSync('tsc', { stdio: 'inherit' });

// 复制package.json并更新其内容
console.log('准备package.json...');
const packageJson = require('../../package.json');

// 安装操作只维护在源码根目录的主手册中
const readmeContent = `# ${packageJson.name}

这是由 AIEasyBrowser 源码构建生成的 Chrome Native Messaging host。

安装、注册、CLI + Skill 和验证步骤见项目主手册 [README_zh.md](../../../README_zh.md)。
此目录不是已发布的 npm 包，不需要全局安装。

扩展会自动启动本程序。Native Messaging host 仅注册到当前用户，不使用系统级安装或自动提权。
`;

fs.writeFileSync(path.join(distDir, 'README.md'), readmeContent);

console.log('复制包装脚本...');
const scriptsSourceDir = path.join(__dirname, '.');
const macOsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.sh');
const windowsWrapperSourcePath = path.join(scriptsSourceDir, 'run_host.bat');

const macOsWrapperDestPath = path.join(distDir, 'run_host.sh');
const windowsWrapperDestPath = path.join(distDir, 'run_host.bat');

try {
  if (fs.existsSync(macOsWrapperSourcePath)) {
    fs.copyFileSync(macOsWrapperSourcePath, macOsWrapperDestPath);
    console.log(`已将 ${macOsWrapperSourcePath} 复制到 ${macOsWrapperDestPath}`);
  } else {
    console.error(`错误: macOS 包装脚本源文件未找到: ${macOsWrapperSourcePath}`);
  }

  if (fs.existsSync(windowsWrapperSourcePath)) {
    fs.copyFileSync(windowsWrapperSourcePath, windowsWrapperDestPath);
    console.log(`已将 ${windowsWrapperSourcePath} 复制到 ${windowsWrapperDestPath}`);
  } else {
    console.error(`错误: Windows 包装脚本源文件未找到: ${windowsWrapperSourcePath}`);
  }
} catch (error) {
  console.error('复制包装脚本时出错:', error);
}

// 为关键JavaScript文件和macOS包装脚本添加可执行权限
console.log('添加可执行权限...');
const filesToMakeExecutable = ['index.js', 'cli.js', 'run_host.sh']; // cli.js 假设在 dist 根目录

filesToMakeExecutable.forEach((file) => {
  const filePath = path.join(distDir, file); // filePath 现在是目标路径
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, '755');
      console.log(`已为 ${file} 添加可执行权限 (755)`);
    } else {
      console.warn(`警告: ${filePath} 不存在，无法添加可执行权限`);
    }
  } catch (error) {
    console.error(`为 ${file} 添加可执行权限时出错:`, error);
  }
});

console.log('写入 node_path.txt...');
writeNodePathFile(distDir, process.execPath);

console.log('✅ 构建完成');
