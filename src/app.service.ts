import {HttpException, Injectable, InternalServerErrorException, Logger} from '@nestjs/common';
import {Cron, CronExpression} from '@nestjs/schedule';
import {StatusEnum} from './status.enum';
import * as mongoose from 'mongoose';
import {Model} from 'mongoose';
import * as process from 'process';

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);
  private signalModel: Model<any>;
  private exchangeInfoModel: Model<any>;
  private binance: any;
  private deposit = {
    maxSum: parseFloat(process.env.MAX_AVAILABLE_SUM),
    maxPairs: parseInt(process.env.MAX_PAIRS),
  };

  constructor(
  ) {
    this.initialize();
  }

  private async initialize() {
    await mongoose.connect(`mongodb://${process.env.MONGODB_HOST}/${process.env.MONGODB_DATABASE}`)
        .then(() => this.logger.log('DB Connected!'));
    const Schema = mongoose.Schema;

    this.signalModel = mongoose.model("Signal", new Schema({
      symbol: String,
      side: String,
      quantity: Number,
      price: Number,
      status: Number,
      message: String,
      order_id: Number,
      date_created: Date,
      date_updated: Date,
    }));
    this.exchangeInfoModel = mongoose.model("Symbols", new Schema({
      data: mongoose.SchemaTypes.Mixed,
    }));

    const Binance = require('node-binance-api');
    this.binance = new Binance().options({
      APIKEY: process.env.API_KEY,
      APISECRET: process.env.API_SECRET,
      test: process.env.TESTNET === 'yes',
      baseURL: process.env.BASE_URL
    });

    await this.exchangeInfo();

    await this.binance.futuresBalance().then(res => {
      if (res.length) {
        let balance = res.filter(function (el) {
          return el.asset === 'USDT';
        });

        this.logger.debug(`Account balance: ${balance[0].balance}`);

        if (!this.deposit.maxSum) {
          this.deposit.maxSum = balance[0].balance;
        }

        this.logger.debug(`Available balance: ${this.deposit.maxSum}`);
      }
    });
  }

  public async closeAllPositions(): Promise<boolean> {
    this.logger.debug('New signal, close all positions');

    await this.binance.futuresPositionRisk().then(res => {
      res.forEach(el => {
        const amt = parseFloat(el.positionAmt);
        if (amt !== 0) {
          console.log(el, amt);
        }
        if (amt > 0) {
          this.binance.futuresMarketSell(el.symbol, amt).then(res => {
            this.logger.debug(`${el.symbol} closed ${JSON.stringify(res)}`);
          });
        }
        if (amt < 0) {
          this.binance.futuresMarketBuy(el.symbol, Math.abs(amt)).then(res => {
            this.logger.debug(`${el.symbol} closed ${JSON.stringify(res)}`);
          });
        }
      });
    });

    const result: any[] = await this.signalModel.find({
      'status': { '$in': [StatusEnum.OPEN, StatusEnum.WAITING] },
    });

    if (!result.length) {
      this.logger.debug('No orders to close');
      return;
    }

    for (const order of result) {
      let isOrderClosed = false;

      await this.binance.futuresOpenOrders(order.symbol).then(res => {
        if (!res.length) {
          isOrderClosed = true;
        }
      });

      if (isOrderClosed) {
        order.status = StatusEnum.CLOSED_AUTO;
        order.date_updated = new Date();
        order.save();
        continue;
      }

      try {
        await this.binance.futuresCancelAll(order.symbol).then(async res => {
          // this.logger.debug(`Cancel all ${order.symbol} order`, res);
          // if (order.side === 'LONG') {
          //   await this.binance.futuresMarketSell(order.symbol, order.quantity);
          // } else {
          //   await this.binance.futuresMarketBuy(order.symbol, order.quantity);
          // }
          order.status = StatusEnum.CLOSED;
          order.date_updated = new Date();
          order.save();
        });
      } catch (e) {
        this.logger.error('Close order', order, e);
      }
    }
  }

  public async storeSignal(data: any): Promise<boolean> {
    if (!data.symbol || !data.side || !data.price) {
      return false;
    }

    try {
      const instance = new this.signalModel();
      instance.symbol = data.symbol;
      instance.side = data.side;
      instance.quantity = 0;
      instance.price = data.price;
      instance.status = StatusEnum.NEW;
      instance.message = '';
      instance.order_id = 0;
      instance.date_created = new Date();
      instance.date_updated = new Date();
      instance.save();

      return true;
    } catch (e) {
      //
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  // @Cron(CronExpression.EVERY_10_SECONDS)
  public async run() {
    const result: any[] = await this.signalModel.find({
      'status': StatusEnum.NEW
    });

    if (!result.length) {
      this.logger.debug('No new signals...');
      return;
    }

    const prices = await this.binance.futuresPrices();

    for (const pair of result) {
      this.logger.debug(`Fixing pair ${pair.symbol}`);

      const symbol = await this.getSymbolInfo(pair.symbol);

      if (symbol[0].pair === pair.symbol) {
        const ticker: any = Object.entries(prices).filter(el => {
          return el[0] === pair.symbol;
        });

        if (!ticker.length) {
          pair.status = StatusEnum.ERROR;
          pair.message = 'Symbol not found';
          pair.save();
          continue;
        }

        let price: any = parseFloat(ticker[0][1]).toFixed(symbol[0].pricePrecision);
        this.deposit.maxPairs = parseInt(process.env.MAX_PAIRS) || result.length;
        pair.quantity = (
            this.deposit.maxSum /
            this.deposit.maxPairs *
            parseInt(process.env.LEVERAGE) /
            price
        ).toFixed(symbol[0].quantityPrecision);

        if (!pair.quantity) {
          pair.status = StatusEnum.PASSED;
        } else {
          pair.status = StatusEnum.WAITING;
        }

        pair.date_updated = new Date();
        pair.save();
      }
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  // @Cron(CronExpression.EVERY_10_SECONDS)
  public async open() {
    const openOrders: any[] = await this.signalModel.find({
      'status': StatusEnum.OPEN
    });
    const result: any[] = await this.signalModel.find({
      'status': StatusEnum.WAITING
    });

    this.logger.debug(`Open orders. Waiting ${result.length} pairs`);

    const prices = await this.binance.futuresPrices();

    for (const pair of result) {
      let symbolInfo = await this.getSymbolInfo(pair.symbol);

      const ticker: any = Object.entries(prices).filter(el => {
        return el[0] === pair.symbol;
      });

      if (!ticker.length) {
        pair.status = StatusEnum.ERROR;
        pair.message = 'Symbol not found';
        pair.save();
        continue;
      }

      let price: any = parseFloat(ticker[0][1]).toFixed(symbolInfo[0].pricePrecision);

      try {
        const dateDiff = new Date().getTime() - pair.date_created;
        const candlesCount = dateDiff / 300000;
        const candles = await this.binance.futuresCandles(pair.symbol, '5m', { limit: candlesCount.toFixed() });
        const priceDiff = Math.abs((candles[candles.length - 1][4] - pair.price) / pair.price * 100).toFixed(2);

        this.logger.debug(`${pair.side} ${pair.symbol} candle closed ${candles[candles.length - 1][4]} (${priceDiff}%)`);

        let isActivePair = true;
        candles.forEach((candle, index) => {
          if (index < candles.length - 2) {
            if (pair.side === 'LONG' && candle[4] > pair.price) {
              isActivePair = false;
            }
            if (pair.side === 'SHORT' && candle[4] < pair.price) {
              isActivePair = false;
            }
          }
        });

        if (!isActivePair) {
          pair.status = StatusEnum.MISSED_ORDER;
          pair.date_updated = new Date();
          pair.save();
          this.logger.debug(`Missed order ${pair.symbol} by price ${pair.price}`);
          continue;
        }

        if (this.checkOrderPrice(pair, candles[candles.length - 1][4], price)) {
          this.logger.debug(`Set leverage ${process.env.LEVERAGE}`);
          await this.binance.futuresLeverage(pair.symbol, parseInt(process.env.LEVERAGE));

          this.logger.debug(`Set margin type ISOLATED`);
          await this.binance.futuresMarginType(pair.symbol, 'ISOLATED');

          this.deposit.maxPairs = parseInt(process.env.MAX_PAIRS) || result.length + openOrders.length;
          const qty = (
              this.deposit.maxSum /
              this.deposit.maxPairs *
              parseInt(process.env.LEVERAGE) /
              price
          ).toFixed(symbolInfo[0].quantityPrecision);

          if (await this.placeOrder(pair, qty, price) === true) {
            pair.status = StatusEnum.OPEN;
            pair.quantity = qty;

            try {
              setTimeout(async () => {
                await this.placeOrder(pair, qty, price, 'STOP_MARKET').catch(async () => {
                  await this.placeOrder(pair, qty, price, 'STOP_MARKET').catch(error => {
                    throw new Error(JSON.stringify(error));
                  });
                });
              }, 3000);

              if (process.env.TRAILING_RATE) {
                setTimeout(async () => {
                  await this.placeOrder(pair, qty, price, 'TRAILING_STOP_MARKET').catch(async () => {
                    await this.placeOrder(pair, qty, price, 'TRAILING_STOP_MARKET').catch(error => {
                      throw new Error(JSON.stringify(error));
                    });
                  });
                }, 3000);
              } else {
                setTimeout(async () => {
                  await this.placeOrder(pair, qty, price, 'TAKE_PROFIT_MARKET').catch(async () => {
                    await this.placeOrder(pair, qty, price, 'TAKE_PROFIT_MARKET').catch(error => {
                      throw new Error(JSON.stringify(error));
                    });
                  });
                }, 3000);
              }
            } catch (e) {
              console.log(e);
              pair.status = StatusEnum.ERROR;
              pair.message = JSON.stringify(e);
            } finally {
              pair.date_updated = new Date();
              pair.save();
            }
          }
        }
      } catch (e) {
        this.logger.error('Open bid', e);
      }
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  // @Cron(CronExpression.EVERY_10_SECONDS)
  public async close() {
    this.logger.debug('Checking orders to close');
    const result: any[] = await this.signalModel.find({
      'status': StatusEnum.OPEN,
    });

    if (!result.length) {
      this.logger.debug('No orders to close');
      return;
    }

    for (const order of result) {
      let isOrderClosed = false;

      await this.binance.futuresOpenOrders(order.symbol).then(res => {
        if (!res.length) {
          isOrderClosed = true;
        }
      });

      if (isOrderClosed) {
        order.status = StatusEnum.CLOSED_AUTO;
        order.date_updated = new Date();
        order.save();
        continue;
      }

      let currDate = new Date();
      let ttl = order.date_updated.getTime() + parseInt(process.env.ORDER_TTL);

      if (currDate.getTime() >= ttl) {
        try {
          await this.binance.futuresCancelAll(order.symbol).then(async res => {
            this.logger.debug(`Cancel all ${order.symbol} order`, res);

            let errors = [];
            if (res.code !== 200) {
              errors.push(res.msg);
            }

            if (order.side === 'LONG') {
              await this.binance.futuresMarketSell(order.symbol, order.quantity).then(res => {
                this.logger.debug(`Sell/Close order ${order.symbol}`, res);
                if (!res.orderId) {
                  errors.push(res.msg);
                }
              });
            } else {
              await this.binance.futuresMarketBuy(order.symbol, order.quantity).then(res => {
                this.logger.debug(`Buy/Close order ${order.symbol}`, res);
                if (!res.orderId) {
                  errors.push(res.msg);
                }
              });
            }

            if (errors.length) {
              order.message = errors.join(', ');
              order.status = StatusEnum.ERROR;
            } else {
              order.status = StatusEnum.CLOSED;
            }
            order.date_updated = new Date();
            order.save();
          });
        } catch (e) {
          this.logger.error('Close order', order, e);
        }
      }
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_10PM)
  public async exchangeInfo() {
    await this.binance.futuresExchangeInfo().then(res => {
      this.logger.debug('Updating exchange info');
      const instance = new this.exchangeInfoModel();
      instance.data = res.symbols;
      instance.save();
    });
  }

  private async getSymbolInfo(symbol) {
    let symbols: any = await this.exchangeInfoModel.find({'data.pair': symbol}).limit(1).sort({$natural: -1});
    return symbols[0].data.filter(function (el) {
      return el.symbol === symbol;
    });
  }

  private checkOrderPrice(pair, candlePrice, price) {
    const takeProfitLong = pair.price + pair.price * parseFloat(process.env.TAKE_PROFIT);
    const takeProfitShort = pair.price - pair.price * parseFloat(process.env.TAKE_PROFIT);
    const stopLong = pair.price - pair.price * parseFloat(process.env.STOP_LOSS);
    const stopShort = pair.price + pair.price * parseFloat(process.env.STOP_LOSS);

    if (
        pair.side === 'LONG' &&
        candlePrice >= pair.price &&
        takeProfitLong > price &&
        stopLong < price
    ) {
      return true;
    }
    if (
        pair.side === 'SHORT' &&
        candlePrice <= pair.price &&
        takeProfitShort < price &&
        stopShort > price
    ) {
      return true;
    }
    return false;
  }

  private async placeOrder(pair, qty, price, type = 'MARKET'): Promise<any> {
    let orders = [];
    let symbol = await this.getSymbolInfo(pair.symbol);
    let stopPrice = type === 'STOP_MARKET' ? (pair.side === 'LONG' ? parseFloat(price) - parseFloat(price) * parseFloat(process.env.STOP_LOSS) : parseFloat(price) + parseFloat(price) * parseFloat(process.env.TAKE_PROFIT)) : (pair.side === 'LONG' ? parseFloat(price) + parseFloat(price) * parseFloat(process.env.TAKE_PROFIT) : parseFloat(price) - parseFloat(price) * parseFloat(process.env.STOP_LOSS));
    let stop = stopPrice.toFixed(symbol[0].pricePrecision);

    if (type === 'MARKET') {
      this.logger.debug(`${pair.side} ${pair.symbol}. Order: ${type}, Price: ${price}, Qty: ${qty}`);
      orders.push({
        symbol: pair.symbol,
        side: pair.side === 'LONG' ? 'BUY' : 'SELL',
        type: 'MARKET',
        quantity: qty.toString(),
        },
      );

      this.logger.debug(`Bid ${type} ${pair.symbol} ${price}`);
    }

    if (type === 'TRAILING_STOP_MARKET') {
      this.logger.debug(`${pair.side} ${pair.symbol}. Order: ${type}, Stop: ${stop}, Qty: ${qty}`);
      orders.push({
        symbol: pair.symbol,
        type: 'TRAILING_STOP_MARKET',
        side: pair.side === 'LONG' ? 'SELL' : 'BUY',
        positionSide: 'BOTH',
        quantity: qty,
        reduceOnly: 'false',
        activatePrice: stop,
        // priceRate: process.env.TRAILING_RATE,
        callbackRate: process.env.TRAILING_RATE,
        workingType: 'MARK_PRICE', // 'CONTRACT_PRICE',
        priceProtect: 'true',
      });
    }

    if (type === 'STOP_MARKET' || type === 'TAKE_PROFIT_MARKET') {
      this.logger.debug(`${pair.side} ${pair.symbol}. Order: ${type}, Stop: ${stop}, Qty: ${qty}`);
      orders.push({
          symbol: pair.symbol,
          side: pair.side === 'LONG' ? 'SELL' : 'BUY',
          positionSide: 'BOTH',
          type: type,
          stopPrice: stop,
          closePosition: 'true',
          timeInForce: 'GTE_GTC',
          workingType: 'MARK_PRICE',
          priceProtect: 'true',
        }
      );
    }

    return new Promise((resolve, reject) => {
      try {
        this.binance.futuresMultipleOrders(orders).then(res => {
          if (!res[0]?.orderId) {
            this.logger.error(`Place order: ${JSON.stringify(res)}`);
            reject(res[0]);
          }
          resolve(true);
        });
      } catch (e) {
        this.logger.error(`Place order: ${JSON.stringify(e)}`);
      }
    });
  }
}
