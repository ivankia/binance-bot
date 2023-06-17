import {Injectable, Logger} from '@nestjs/common';
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
          this.logger.debug(`Cancel all ${order.symbol} order`, res);
          if (order.side === 'LONG') {
            await this.binance.futuresMarketSell(order.symbol, order.quantity);
          } else {
            await this.binance.futuresMarketBuy(order.symbol, order.quantity);
          }
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

    for (const pair of result) {
      this.logger.debug(`Fixing pair ${pair.symbol}`);

      const symbol = await this.getSymbolInfo(pair.symbol);

      if (symbol[0].pair === pair.symbol) {
        const price = await this.getMarketPrice(pair.symbol, symbol[0].pricePrecision);

        this.deposit.maxPairs = parseInt(process.env.MAX_PAIRS) || result.length;
        pair.quantity = (
            // parseFloat(process.env.MAX_AVAILABLE_SUM) /
            // parseInt(process.env.MAX_PAIRS) *
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
    this.logger.debug('Opening bids');

    const result: any[] = await this.signalModel.find({
      'status': StatusEnum.WAITING
    });

    this.logger.debug(`Orders waiting to open (${result.length})`, result);

    for (const pair of result) {
      this.logger.debug(`Pair ${pair.symbol}`);
      let symbolInfo = await this.getSymbolInfo(pair.symbol);

      try {
        const candle = await this.binance.futuresCandles(pair.symbol, '5m', { limit: 2 });
        this.logger.debug('Candle 5m', candle[0]);

        const price = await this.getMarketPrice(pair.symbol, symbolInfo[0].pricePrecision);

        if (this.checkOrderPrice(pair, candle[0][4], price)) {
          this.logger.debug(`Set leverage ${process.env.LEVERAGE}`);
          await this.binance.futuresLeverage(pair.symbol, parseInt(process.env.LEVERAGE));

          this.logger.debug(`Set margin type ISOLATED`);
          await this.binance.futuresMarginType(pair.symbol, 'ISOLATED');

          this.deposit.maxPairs = parseInt(process.env.MAX_PAIRS) || result.length;
          const qty = (
              // parseFloat(process.env.MAX_AVAILABLE_SUM) /
              // parseInt(process.env.MAX_PAIRS) *
              this.deposit.maxSum /
              this.deposit.maxPairs *
              parseInt(process.env.LEVERAGE) /
              price
          ).toFixed(symbolInfo[0].quantityPrecision);

          this.logger.debug(`Opening order by market, set stops. Price: ${price}, Qty: ${qty}, Side: ${pair.side}`);

          let orders = [
            {
              symbol: pair.symbol,
              side: pair.side === 'LONG' ? 'BUY' : 'SELL',
              type: 'MARKET',
              quantity: qty.toString(),
            },
            {
              symbol: pair.symbol,
              side: pair.side === 'LONG' ? 'SELL' : 'BUY',
              positionSide: 'BOTH',
              type: 'STOP_MARKET',
              stopPrice: (
                  pair.side === 'LONG' ?
                  pair.price - pair.price * parseFloat(process.env.STOP_LOSS) :
                  pair.price + pair.price * parseFloat(process.env.TAKE_PROFIT)
                ).toFixed(symbolInfo[0].pricePrecision),
              closePosition: 'true',
              timeInForce: 'GTE_GTC',
              workingType: 'MARK_PRICE',
              priceProtect: 'true',
            },
          ];

          this.logger.debug('Orders', orders);

          let success = false;

          await this.binance.futuresMultipleOrders(orders).then(res => {
            if (!res[0]?.orderId || !res[1]?.orderId) {
              pair.message = pair.message + JSON.stringify(res);
              pair.status = StatusEnum.ERROR;
              this.logger.error('Place order error', res);
            } else {
              pair.order_id = res[0]?.orderId;
              success = true;
              this.logger.debug('Orders executed', res);
            }
          });

          if (success) {
            await this.binance.futuresMultipleOrders([
              {
                symbol: pair.symbol,
                side: pair.side === 'LONG' ? 'SELL' : 'BUY',
                positionSide: 'BOTH',
                type: 'TAKE_PROFIT_MARKET',
                stopPrice: (
                    pair.side === 'LONG' ?
                        pair.price + pair.price * parseFloat(process.env.TAKE_PROFIT) :
                        pair.price - pair.price * parseFloat(process.env.STOP_LOSS)
                ).toFixed(symbolInfo[0].pricePrecision),
                closePosition: 'true',
                timeInForce: 'GTE_GTC',
                workingType: 'MARK_PRICE',
                priceProtect: 'true',
              },
            ]).then(res => {
              if (!res[0]?.orderId) {
                pair.message = pair.message + JSON.stringify(res);
                pair.status = StatusEnum.ERROR;
                this.logger.error('Place order error', res);
              } else {
                pair.order_id = res[0]?.orderId;
                success = true;
                this.logger.debug('Orders executed', res);
              }
            });
          }

          if (success) {
            pair.status = StatusEnum.OPEN;
          } else {
            pair.message = 'Place order error: ' + pair.message;
          }
        }
        // else {
        //   pair.message = 'Check price error';
        //   pair.status = StatusEnum.INVALID_ORDER
        // }

        pair.date_updated = new Date();
        pair.save();
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

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  public async exchangeInfo() {
    await this.binance.futuresExchangeInfo().then(res => {
      this.logger.debug('Updating exchange info');
      const instance = new this.exchangeInfoModel();
      instance.data = res.symbols;
      instance.save();
    });
  }

  private async getSymbolInfo(symbol) {
    let symbols: any = await this.exchangeInfoModel.find({'data.pair': symbol}).limit(1).sort({$natural: -1})
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

  private async getMarketPrice(symbol, pricePrecision = 0) {
    let price;
    await this.binance.futuresMarkPrice(symbol).then(res => {
      price = parseFloat(res.markPrice).toFixed(pricePrecision);
    });
    return price;
  }
}
