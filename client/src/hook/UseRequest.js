import axios from 'axios';
import { useState } from 'react';

 const UseRequest = ({url, method, body, onSuccess}) => {
    // method nust be equal  to get, post, patch
    const [errors, setErrors] = useState(null);

    const doRequest = async (props = {}) => {
        try {
            setErrors(null);
            const response = await axios[method](url, {...body, ...props});

            if (onSuccess) {
                onSuccess(response.data);
            }
            return response.data;
        } catch (err) {
            console.log(err);
            console.log(err.response.data.errors);
            setErrors(
                <div className="alert alert-danger">
                    <h4>Ooops...</h4>
                    <ul className="my-0">
                        {err.response.data.errors.map(err => <li key={err.msg}>{err.msg}</li>)}
                    </ul>
                </div>
            )
        }

    };

    return { doRequest, errors };
}

export default UseRequest;