import EventEmitter from 'events';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import _ from 'lodash';
import getPicture from './Core.js';
import { nsfwCheck } from '../utils/nsfw.js';
import Config from './Config.js';

class TaskQueue extends EventEmitter {
    constructor(token) {
        super();
        this.queue = [];
        this.lock = false;
        this.token = token;
    }

    enqueue(task) {
        this.queue.push(task);
        this.processNextTask();
    }

    async processNextTask() {
        if (this.lock || !this.queue.length) return;
        this.lock = true;
        const task = this.queue.shift();

        try {
            const config = Config.getConfig();
            const picInfo = await getPicture(task.param, task.user, task.type, this.token);

            if (config.nsfw_check.engine) {
                const nsfw = await nsfwCheck(picInfo.base64);
                if (nsfw) throw new Error('🔞 图片内容不符合规定\n💡 生成的图片可能包含不当内容，已被系统自动拦截\n建议: 请尝试使用更合适的提示词重新生成');
            }
            task._callback?.resolve(picInfo)
        } catch (error) {
            logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`生成图片失败`), logger.red(error));
            task._callback?.reject(error)
        } finally {
            this.lock = false;
            if (this.queue.length) this.processNextTask();
        }
    }
}

class QueueList {
    constructor() {
        this.list = [];
        this.lastIndex = 0;
        this.init();
    }

    async init() {
        try {
            const config = await Config.getConfig();
            const { proxy, novelai_token } = config;
            const agent = proxy.enable 
                ? new HttpsProxyAgent(`http://${proxy.host}:${proxy.port}`)
                : null;

            this.list = (await Promise.all(novelai_token.map(async (token, index) => {
                try {
                    const tokenDisplay = `${token.substring(0, 8)}...${token.slice(-8)}`;
                    logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`正在验证Token ${index + 1}: ${tokenDisplay}`));
                    
                    const requestConfig = {
                        headers: { 
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'application/json',
                            'Accept': 'application/json'
                        },
                        timeout: 10000
                    };
                    
                    if (agent) {
                        requestConfig.httpsAgent = agent;
                        requestConfig.httpAgent = agent;
                    }
                    
                    logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`Queue初始化使用代理: ${proxy.enable ? `${proxy.host}:${proxy.port}` : '无'}`));
                    
                    const response = await axios.get(`${config.reverse_proxy.user_url}/user/data`, requestConfig);
                    
                    logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`Token ${index + 1} 验证成功，状态码: ${response.status}`));
                    
                    const { active, trainingStepsLeft: { fixedTrainingStepsLeft, purchasedTrainingSteps } } = response.data.subscription;
                    return (active || purchasedTrainingSteps > 0 || fixedTrainingStepsLeft > 0) ? new TaskQueue(token) : null;
                } catch (error) {
                    const tokenDisplay = `${token.substring(0, 8)}...${token.slice(-8)}`;
                    
                    if (error.response) {
                        logger.mark(
                            logger.blue('[NAI PLUGIN]'), 
                            logger.cyan(`Token ${index + 1} (${tokenDisplay}) 验证失败`),
                            logger.red(`状态码: ${error.response.status}, 状态文本: ${error.response.statusText}`)
                        );
                        if (error.response.data) {
                            logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan('响应数据:'), logger.red(JSON.stringify(error.response.data)));
                        }
                    } else if (error.request) {
                        logger.mark(
                            logger.blue('[NAI PLUGIN]'), 
                            logger.cyan(`Token ${index + 1} (${tokenDisplay}) 网络请求失败`),
                            logger.red(error.message)
                        );
                    } else {
                        logger.mark(
                            logger.blue('[NAI PLUGIN]'), 
                            logger.cyan(`Token ${index + 1} (${tokenDisplay}) 初始化失败`),
                            logger.red(error.message)
                        );
                    }
                    return null;
                }
            }))).filter(Boolean);
        } catch (error) {
            logger.mark(logger.blue('[NAI PLUGIN]'), logger.cyan(`队列初始化失败`), logger.red(error));
        }
    }

    enqueue(task) {
        const config = Config.getConfig();
        let queue = config.use_token
            ? this.list.find(q => q.token === config.novelai_token[config.use_token - 1])
            : this.list[0] || this.findAvailableQueue() || _.orderBy(this.list, ['size'], ['asc'])[0];

        queue?.enqueue(task);
        return queue?.size ?? 0;
    }

    findAvailableQueue() {
        for (let i = 1; i <= this.list.length; i++) {
            const index = (this.lastIndex + i) % this.list.length;
            if (!this.list[index].lock) {
                this.lastIndex = index;
                return this.list[index];
            }
        }
    }
}

export default new QueueList();