import React from 'react';

const OldMetalReceipt = React.forwardRef(({ data }, ref) => {
  if (!data) return null;

  const { customer, items, totals, voucherNo } = data;

  return (
    <div ref={ref} className="p-4" style={{ fontFamily: 'monospace', color: '#000', backgroundColor: '#fff' }}>
      {/* HEADER */}
      <div className="text-center mb-4 border-bottom pb-3">
        <h3 className="fw-bold m-0">AURUM JEWELLERY</h3>
        <p className="m-0 small">Main Market, Salem - 636001</p>
        <p className="m-0 small">Phone: 98765 43210</p>
        <h5 className="mt-2 text-decoration-underline">OLD METAL PURCHASE VOUCHER</h5>
      </div>

      {/* INFO */}
      <div className="d-flex justify-content-between mb-3 small">
        <div>
            <div><strong>Voucher No:</strong> {voucherNo}</div>
            <div><strong>Date:</strong> {new Date().toLocaleString()}</div>
        </div>
        <div className="text-end">
            <div><strong>Customer:</strong> {customer.customer_name}</div>
            <div><strong>Mobile:</strong> {customer.mobile}</div>
        </div>
      </div>

      {/* TABLE */}
      <table className="table table-bordered table-sm small border-dark">
        <thead className="table-light">
          <tr>
            <th>#</th>
            <th>Item</th>
            <th>Type</th>
            <th className="text-end">Gross</th>
            <th className="text-end">Less</th>
            <th className="text-end">Net Wt</th>
            <th className="text-end">Rate</th>
            <th className="text-end">Value</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              <td>{item.item_name}</td>
              <td>{item.metal_type}</td>
              <td className="text-end">{parseFloat(item.gross_weight).toFixed(3)}</td>
              <td className="text-end">
                  {parseFloat(item.less_weight).toFixed(3)} <br/>
                  <span className="text-muted" style={{fontSize: '0.8em'}}>({item.less_percent}%)</span>
              </td>
              <td className="text-end fw-bold">{parseFloat(item.net_weight).toFixed(3)}</td>
              <td className="text-end">{item.rate}</td>
              <td className="text-end">{parseFloat(item.amount).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="fw-bold">
            <tr>
                <td colSpan="7" className="text-end">Sub Total</td>
                <td className="text-end">₹{totals.totalAmount.toLocaleString()}</td>
            </tr>
            {totals.gstAmount > 0 && (
                <tr>
                    <td colSpan="7" className="text-end">Less: GST Deduction</td>
                    <td className="text-end text-danger">- ₹{totals.gstAmount.toLocaleString()}</td>
                </tr>
            )}
            <tr className="fs-6">
                <td colSpan="7" className="text-end">NET PAYABLE CASH</td>
                <td className="text-end">₹{totals.netPayout.toLocaleString()}</td>
            </tr>
        </tfoot>
      </table>

      {/* FOOTER */}
      <div className="row mt-5 pt-4">
        <div className="col-6 text-center">
            <div className="border-top border-dark w-75 mx-auto pt-2">Customer Signature</div>
        </div>
        <div className="col-6 text-center">
            <div className="border-top border-dark w-75 mx-auto pt-2">Authorized Signatory</div>
        </div>
      </div>
      
      <div className="text-center mt-4 small text-muted">
          * This is a computer generated voucher.
      </div>
    </div>
  );
});

export default OldMetalReceipt;