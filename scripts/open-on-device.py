#!/usr/bin/env python3
"""
XXYXXReader v2 · 墨水屏设备一键直达自动化脚本
用法:
  python3 scripts/open-on-device.py                  # 默认打开水墨书架
  python3 scripts/open-on-device.py <bookId>          # 打开指定书籍 (例如: book_b6350543f39e3f71)
  python3 scripts/open-on-device.py <full_url>        # 打开完整网址
"""

import subprocess
import time
import os
import sys

BASE_HOST = "http://192.168.0.103:8999"

def get_device():
    # 优先使用已知海信墨水屏序列号
    known = "a7c39fa0"
    res = subprocess.run("adb devices", shell=True, capture_output=True, text=True).stdout
    lines = [line.split()[0] for line in res.strip().splitlines()[1:] if "\tdevice" in line]
    if known in lines:
        return known
    if lines:
        return lines[0]
    print("[错误] 未检测到任何已连接并授权的 ADB 设备，请检查 USB 调试。")
    sys.exit(1)

def adb_cmd(device, cmd):
    full = f"adb -s {device} {cmd}"
    res = subprocess.run(full, shell=True, capture_output=True, text=True)
    return res.stdout.strip()

def main():
    device = get_device()
    target_arg = sys.argv[1] if len(sys.argv) > 1 else ""

    if not target_arg:
        target_url = f"{BASE_HOST}/"
    elif target_arg.startswith("http://") or target_arg.startswith("https://"):
        target_url = target_arg
    elif target_arg.startswith("book_"):
        target_url = f"{BASE_HOST}/reader.html?id={target_arg}"
    else:
        target_url = target_arg

    print(f"==> [1/6] 选定设备: {device}")
    print(f"==> [2/6] 准备直达目标: {target_url}")

    # 清理潜在的顶层遮挡窗口
    adb_cmd(device, "shell am force-stop com.android.documentsui")
    adb_cmd(device, "shell am force-stop com.ipbrowser.app")
    time.sleep(0.5)

    print("==> [3/6] 临时切换纯英文输入法，避免中文拼音干扰键入...")
    adb_cmd(device, "shell ime set com.android.inputmethod.latin/.LatinIME")
    time.sleep(0.3)

    print("==> [4/6] 启动 IpBrowser 并键入目标 URL...")
    adb_cmd(device, "shell am start -n com.ipbrowser.app/.MainActivity")
    time.sleep(1.2)

    adb_cmd(device, "shell input tap 360 260")
    time.sleep(0.2)
    # 连续退格清空输入框
    adb_cmd(device, "shell 'for i in $(seq 1 40); do input keyevent 67; done'")
    time.sleep(0.2)

    safe_url = target_url.replace("?", "\\?").replace("&", "\\&")
    adb_cmd(device, f"shell input text '{safe_url}'")
    time.sleep(0.4)

    print("==> [5/6] 发送回车，直接开卷...")
    adb_cmd(device, "shell input keyevent 66")
    time.sleep(0.3)

    # 恢复默认讯飞输入法
    adb_cmd(device, "shell ime set com.iflytek.inputmethod/.FlyIME")

    print("==> [6/6] 等待页面展卷...")
    time.sleep(3.5)

    screenshot_path = "/tmp/eink_opened.png"
    os.system(f"adb -s {device} exec-out screencap -p > {screenshot_path}")
    print(f"==> 展卷成功！当前设备屏幕截图已保存至: {screenshot_path}")

if __name__ == "__main__":
    main()
