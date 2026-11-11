export function listenErrorMessages(error, port, origin) {
  if (error?.code === 'EADDRINUSE') {
    return [
      `端口 ${port} 已被占用。票夹可能已经在运行，请先打开：${origin}`,
      '如果该地址无法访问，请关闭占用此端口的程序后再启动。',
    ];
  }
  return [`本机票夹启动失败：${error?.message || '未知错误'}`];
}
