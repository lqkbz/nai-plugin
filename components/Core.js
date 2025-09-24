import axios from "axios";
import Config from "./Config.js";
import download from "./Download.js";
import _ from "lodash";
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs'

const def = Config.getConfig().parameters;

const createPrompt = (base, isNegative = false) => ({
  caption: { base_caption: base, char_captions: [] },
  ...(!isNegative && { use_coords: false, use_order: true })
});

const commonParameters = {
  params_version: 3,
  width: def.width,
  height: def.height,
  scale: def.scale,
  sampler: def.sampler,
  steps: def.steps,
  n_samples: 1,
  ucPreset: 0,
  qualityToggle: true,
  dynamic_thresholding: false,
  controlnet_strength: 1,
  legacy: false,
  add_original_image: true,
  cfg_rescale: def.cfg_rescale,
  noise_schedule: def.noise_schedule,
  legacy_v3_extend: false,
  skip_cfg_above_sigma: null,
  use_coords: false,
  characterPrompts: [],
  v4_prompt: createPrompt(""),
  v4_negative_prompt: createPrompt(def.negative_prompt, true),
  negative_prompt: def.negative_prompt,
  reference_image_multiple: [],
  reference_information_extracted_multiple: [],
  reference_strength_multiple: []
};

const defaultParam = {
  text: {
    input: "",
    model: await Config.getConfig().model,
    action: "generate",
    parameters: commonParameters
  },
  image: {
    input: "",
    model: await Config.getConfig().model,
    action: "img2img",
    parameters: {
      ...commonParameters,
      strength: 0.7,
      noise: 0.2,
      image: "",
    }
  }
};

const headers = {
  authority: "api.novelai.net",
  Origin: "https://novelai.net",
  Referer: "https://novelai.net",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Content-Type": "application/json"
};

async function getPicture(param, user, type, token) {
  const { base_url } = Config.getConfig().reverse_proxy;
  const mergeData = _.merge({}, defaultParam[type], param);

  const { free_mode, proxy } = Config.getConfig();
  const agent = proxy.enable 
    ? new HttpsProxyAgent(`http://${proxy.host}:${proxy.port}`)
    : null;

  const roundTo64 = v => Math.round(v / 64) * 64 || 64;
  let width = roundTo64(mergeData.parameters.width);
  let height = roundTo64(mergeData.parameters.height);

  const maxArea = free_mode ? 1048576 : 3145728;
  let area = width * height;
  if (area > maxArea) {
    const ratio = width / height;
    const scale = Math.sqrt(maxArea / area);
    width = roundTo64(width * scale);
    height = roundTo64(width / ratio);

    while ((width * height) > maxArea) {
      width -= 64;
      height = roundTo64(width / ratio);
    }
  }
  mergeData.parameters.width = Math.max(width, 64);
  mergeData.parameters.height = Math.max(height, 64);

  if (free_mode) {
    mergeData.parameters.steps = Math.min(mergeData.parameters.steps, 28);
  }

  logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`用户 ${user} 参数：`), mergeData);

  try {
    const requestConfig = {
      headers: { ...headers, Authorization: `Bearer ${token}` },
      responseType: 'arraybuffer'
    };
    
    if (agent) {
      requestConfig.httpsAgent = agent;
      requestConfig.httpAgent = agent;
    }
    
    logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`绘制图片使用代理: ${proxy.enable ? `${proxy.host}:${proxy.port}` : '无'}`));
    
    const response = await axios.post(`${base_url}/ai/generate-image`, mergeData, requestConfig);

    const fileName = Date.now();
    return {
      base64: fs.readFileSync(await download(response.data, user, fileName), 'base64'),
      fileName
    };
  } catch (error) {
    let userErrorMessage = '绘制图片失败';  // 发送给用户的简洁消息
    let logPrefix = '[NAI PLUGIN] 绘制图片失败';  // 日志前缀
    
    if (error.response) {
      // 服务器返回了错误响应
      const { status, statusText, data } = error.response;
      
      // 详细日志记录（开发者调试用）
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`${logPrefix} - HTTP状态码: ${status}`));
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`状态文本: ${statusText}`));
      
      // 提取服务器错误信息
      let serverError = '';
      if (data) {
        if (typeof data === 'string') {
          serverError = data;
          logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`服务器错误: ${data}`));
        } else if (data.message) {
          serverError = data.message;
          logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`服务器错误: ${data.message}`));
        } else {
          try {
            serverError = JSON.stringify(data);
            logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`服务器响应: ${serverError}`));
          } catch {
            serverError = statusText;
          }
        }
      } else {
        serverError = statusText;
      }
      
      // 根据不同的HTTP状态码创建用户友好的错误消息
      switch (status) {
        case 400:
          userErrorMessage = `🚫 请求参数错误 \n💡 建议: 请检查提示词格式或图片参数`;
          break;
        case 401:
          userErrorMessage = `🔑 Token验证失败\n💡 建议: 请检查Token是否正确配置`;
          break;
        case 402:
          userErrorMessage = `💳 账户余额不足 \n💡 建议: 请检查NovelAI订阅状态或账户余额`;
          break;
        case 403:
          userErrorMessage = `⛔ 访问被拒绝 \n💡 建议: 内容可能违规，请尝试修改提示词`;
          break;
        case 429:
          userErrorMessage = `⏳ 请求过于频繁 \n💡 建议: 请稍等片刻后再试`;
          break;
        case 500:
        case 502:
        case 503:
          userErrorMessage = `🔧 服务器错误 \n💡 建议: NovelAI服务器暂时不可用，请稍后重试`;
          break;
        case 404:
          userErrorMessage = `❓ API端点不存在 \n💡 建议: 请检查插件配置或联系管理员`;
          break;
        default:
          userErrorMessage = `❌ HTTP错误 \n💡 建议: 请稍后重试或联系管理员`;
      }
      
    } else if (error.request) {
      // 请求已发出但没有收到响应 (网络错误)
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`${logPrefix} - 网络错误: ${error.message}`));
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`错误代码: ${error.code || '未知'}`));
      
      if (error.code === 'ECONNABORTED') {
        userErrorMessage = `⏰ 网络请求超时\n💡 建议: 请检查网络连接状况或VPN代理设置`;
      } else if (error.code === 'ENOTFOUND') {
        userErrorMessage = `🌐 无法连接到服务器\n💡 建议: 请检查网络连接或确认VPN是否正常工作`;
      } else if (error.code === 'ECONNREFUSED') {
        userErrorMessage = `🚫 连接被拒绝\n💡 建议: 请检查代理设置，确认代理服务器正常运行`;
      } else if (error.code === 'CERT_HAS_EXPIRED') {
        userErrorMessage = `🔐 SSL证书已过期\n💡 建议: 请检查系统时间或网络设置`;
      } else {
        userErrorMessage = `🌐 网络连接错误\n详情: ${error.message}\n💡 建议: 请检查网络连接或代理设置`;
      }
      
    } else {
      // 其他类型的错误 
      logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`${logPrefix} - 未知错误: ${error.message}`));
      userErrorMessage = `❌ 未知错误\n详情: ${error.message}\n💡 建议: 请查看控制台日志或联系管理员`;
    }
    
    // 记录完整的错误堆栈用于开发者调试
    logger.mark(logger.blue('[NAI PLUGIN]'), logger.red('完整错误堆栈:'), logger.red(error.stack || '无堆栈信息'));
    
    // 抛出用户友好的错误消息，这个会发送到QQ
    throw new Error(userErrorMessage);
  }
}

export default getPicture