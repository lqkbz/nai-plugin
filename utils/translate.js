import Config from '../components/Config.js'
import axios from 'axios'
import crypto from 'crypto'
import { HttpsProxyAgent } from 'https-proxy-agent'

const SYSTEM = `
你是专业的中文到英文NovelAI提示词翻译专家。
任务：将用户提供的中文描述翻译为英文关键词，并为重要元素添加权重标记。

输出格式要求：
- 仅输出英文关键词，用逗号分隔
- 不要添加任何解释、注释或其他文字
- 对重要元素使用{tag}增加权重，次要元素使用[tag]降低权重

翻译原则：
- 只需要翻译中文部分，英文部分不要更改，原样返回即可
- 不要更改文字排列顺序，翻译后应放回原文中，不应该放在末尾或最前面
- 准确翻译原文描述的视觉元素和场景
- 为主体和重要特征添加{}权重增强
- 为次要或背景元素添加[]权重降低
- 不要添加原文未提及的元素
- 若存在角色名称，需同时给出角色名和所属作品名，例如：纳西妲=>nahida, genshin impact

注意事项：
- 不要自行添加画风标签、质量标签
- 这些特殊标签将由系统另行处理
- 专注于内容翻译和权重分配
`

const ERROR_MAP = {
    52001: '⏰ 百度翻译请求超时\n💡 建议: 请稍后重试',
    52002: '🔧 百度翻译系统错误\n💡 建议: 请稍后重试',
    52003: '🔑 百度翻译未授权\n💡 建议: 请检查AppID配置或服务状态',
    54000: '📝 百度翻译参数缺失\n💡 建议: 请检查翻译配置',
    54001: '✍️ 百度翻译签名错误\n💡 建议: 请检查密钥配置',
    54003: '⏳ 百度翻译频率限制\n💡 建议: 请认证后切换高级版或稍后重试',
    54004: '💳 百度翻译账户余额不足\n💡 建议: 请充值后重试',
    54005: '🚦 百度翻译请求过于频繁\n💡 建议: 请等待3秒后重试',
    58000: '🌐 百度翻译IP限制\n💡 建议: 请检查IP白名单设置',
    58001: '🔤 不支持的翻译语言\n💡 建议: 请检查语言配置',
    58002: '🔒 百度翻译服务已关闭\n💡 建议: 请确认服务状态',
    90107: '❌ 百度翻译认证失败\n💡 建议: 请检查认证信息'
}

const TRANSLATE_STRATEGIES = {
    baidu: {
        handler: async (keyword, config) => {
            const { appid, appkey } = config.translate.baidu
            const salt = crypto.randomBytes(16).toString('hex').slice(0, 16)
            const sign = crypto
                .createHash('md5')
                .update(`${appid}${keyword}${salt}${appkey}`)
                .digest('hex')

            const { data } = await axios.get('http://api.fanyi.baidu.com/api/trans/vip/translate', {
                params: { q: keyword, from: 'zh', to: 'en', appid, salt, sign }
            })

            if (data.error_code) {
                logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`Baidu翻译功能出现问题`), logger.red(data.error_code));
                throw new Error(ERROR_MAP[data.error_code] || `❌ 百度翻译未知错误 (${data.error_code})\n💡 建议: 请检查控制台日志或联系管理员`)
            }
            return data.trans_result[0].dst
        }
    },
    openai: {
        handler: async (keyword, config) => {
            const {
                proxy: { enable, host, port },
                translate: { openai: { base_url, model, apikey } }
            } = config;

            const agent = enable ? new HttpsProxyAgent(`http://${host}:${port}`) : null;

            try {
                // 使用DeerAPI中转服务
                const deerApiUrl = base_url || "https://api.deerapi.com";
                
                const requestConfig = {
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Authorization': apikey.startsWith('Bearer ') ? apikey : `Bearer ${apikey}`,
                        'User-Agent': 'DeerAPI/1.0.0 (https://api.deerapi.com)'
                    }
                };

                if (agent) {
                    requestConfig.httpsAgent = agent;
                    requestConfig.httpAgent = agent;
                }

                const response = await axios.post(
                    `${deerApiUrl}/v1/chat/completions`,
                    {
                        model: model || "gpt-4o-mini",
                        messages: [
                            {
                                role: "system",
                                content: SYSTEM
                            },
                            {
                                role: "user",
                                content: `请将以下中文描述翻译为英文关键词，并为重要元素添加权重标记：${keyword}`
                            }
                        ]
                    },
                    requestConfig
                );

                const text = response.data?.choices?.[0]?.message?.content;
                if (!text) throw new Error('🤖 DeerAPI翻译功能异常\n💡 建议: 请检查API配置或稍后重试');

                logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`DeerAPI翻译成功: ${keyword} -> ${text.substring(0, 50)}...`));
                return text;
                
            } catch (error) {
                logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`DeerAPI翻译功能出现问题`), logger.red(error));
                
                if (error.response) {
                    const { status, statusText, data } = error.response;
                    logger.mark(logger.blue('[NAI PLUGIN]'), logger.red(`DeerAPI错误 - 状态码: ${status}, 响应: ${JSON.stringify(data)}`));
                    
                    switch (status) {
                        case 401:
                            throw new Error('🔑 DeerAPI认证失败\n💡 建议: 请检查API Key是否正确配置');
                        case 429:
                            throw new Error('⏳ DeerAPI请求频率过高\n💡 建议: 请稍后重试');
                        case 500:
                        case 502:
                        case 503:
                            throw new Error('🔧 DeerAPI服务器错误\n💡 建议: 请稍后重试');
                        default:
                            throw new Error(`❌ DeerAPI错误 (${status})\n💡 建议: 请检查API配置或联系管理员`);
                    }
                } else if (error.request) {
                    throw new Error('🌐 无法连接到DeerAPI服务器\n💡 建议: 请检查网络连接或代理设置');
                } else {
                    throw new Error(`🤖 DeerAPI翻译服务异常: ${error.message}\n💡 建议: 请检查API配置或网络连接`);
                }
            }
        }
    }
}

export async function translate(keyword) {
    if (!/[\u4e00-\u9fa5]/.test(keyword)) {
        return keyword
    }
    try {
        const config = await Config.getConfig()
        const engine = config.translate?.engine || ''

        if (!engine) {
            return keyword
        }

        if (!TRANSLATE_STRATEGIES[engine]) {
            throw new Error(`⚙️ 翻译引擎配置错误\n💡 建议: 请检查翻译引擎设置`)
        }

        return await TRANSLATE_STRATEGIES[engine].handler(keyword, config)

    } catch (error) {
        logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`翻译功能出现问题`), logger.red(error));
        const errorMsg = error.response?.data?.error?.message || error.message
        throw new Error(errorMsg || `❌ 翻译功能未知错误\n💡 建议: 请检查控制台日志或联系管理员`)
    }
}