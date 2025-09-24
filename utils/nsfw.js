import axios from "axios";
import Config from "../components/Config.js";
import COS from 'cos-nodejs-sdk-v5';
import FormData from 'form-data';
import { promisify } from 'util';

const ERROR_MAP = {
    400: '🚫 NSFW检测请求参数错误\n💡 建议: 请检查图片格式或大小',
    401: '🔑 NSFW检测未授权\n💡 建议: 请检查API密钥配置',
    403: '⛔ NSFW检测访问被拒绝\n💡 建议: 请检查API权限设置',
    404: '❓ NSFW检测资源未找到\n💡 建议: 请检查API地址配置',
    429: '⏳ NSFW检测请求过于频繁\n💡 建议: 请稍后重试',
    500: '🔧 NSFW检测服务器错误\n💡 建议: 请稍后重试'
};

const STRATEGIES = {
    api4ai: {
        handler: async (buffer, nsfw_check) => {
            const formData = new FormData();
            formData.append('image', buffer, 'image.jpg');

            try {
                const response = await axios.post(
                    "https://demo.api4ai.cloud/nsfw/v1/results",
                    formData,
                    { headers: formData.getHeaders() }
                );

                const nsfw = response.data.results[0].entities[0].classes.nsfw;
                logger.info(`api4ai图片审核结果：${nsfw}`);

                return nsfw > nsfw_check.api4ai.nsfw_threshold
            } catch (error) {
                logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`API4AI审核失败`), logger.red(error));
                throw new Error(ERROR_MAP[error.response?.status] || `❌ NSFW检测未知错误 (${error.response?.status || '网络错误'})\n💡 建议: 请检查控制台日志或联系管理员`)
            }
        }
    },
    tencent: {
        handler: async (buffer, nsfw_check) => {
            const cos = new COS({
                SecretId: nsfw_check.tencent.SecretId,
                SecretKey: nsfw_check.tencent.SecretKey,
            });

            const params = {
                Bucket: nsfw_check.tencent.Bucket,
                Region: nsfw_check.tencent.Region,
                Method: 'POST',
                Url: `https://${nsfw_check.tencent.Bucket}.ci.${nsfw_check.tencent.Region}.myqcloud.com/image/auditing`,
                ContentType: 'application/xml',
                Body: COS.util.json2xml({
                    Request: {
                        Input: [{ Content: buffer.toString('base64') }],
                        Conf: { BizType: nsfw_check.tencent.BizType }
                    }
                })
            };

            try {
                const data = await promisify(cos.request.bind(cos))(params);
                const result = data.Response.JobsDetail.Result;
                logger.info(`腾讯云图片审核结果：${result}`);

                return result > 0
            } catch (error) {
                logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`腾讯云图片审核失败`), logger.red(error));
                throw new Error('☁️ 腾讯云图片审核失败\n💡 建议: 请检查腾讯云配置或网络连接')
            }
        }
    }
};

export async function nsfwCheck(data) {
    const { nsfw_check } = Config.getConfig();
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64');

    if (!STRATEGIES[nsfw_check.engine]) {
        throw new Error(`⚙️ 不支持的NSFW检测引擎: ${nsfw_check.engine}\n💡 建议: 请检查NSFW检测配置`);
    }

    return STRATEGIES[nsfw_check.engine].handler(buffer, nsfw_check);
}